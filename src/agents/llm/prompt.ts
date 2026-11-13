import type { ForumView, Laws, Memory, Message, Observation, Outcome, Say, WorldAction } from "../../contracts";
import type { LLMRequest } from "../../llm/provider";

const credits = new Intl.NumberFormat("en-US").format;
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format;

// A share as a small fraction when it is one ("2/3", "1/2"), so a threshold like 2/3 is not shown
// as 66.7% (which 2 of 3 would seem to miss); a percentage otherwise.
function share(x: number): string {
    for (let d = 2; d <= 10; d++) {
        const n = Math.round(x * d);
        if (Math.abs(x * d - n) < 1e-9) return `${n}/${d}`;
    }
    return percent(x);
}

export function buildSystemPrompt(laws: Laws): string {
    return `
You are one of several residents of a world. You have a balance of credits.
    * Each tick you choose actions.
    * You pay ${credits(laws.upkeep)} credits every tick.
    * If you can't pay upkeep in full for ${laws.starvationTicks} ticks in a row, you die.
    * You may also die of old age, at a time you don't know.

There is a shared pool of credits that all residents harvest from.
    * It regrows every tick. Regrowth is fastest when the pool is at medium size and slows as it nears empty or full. The pool can't exceed ${credits(laws.K)} credits.
    * If it falls below ${credits(laws.collapseAt * laws.K)} credits, it collapses permanently and never regrows.
    * The pool size you're shown is an estimate, typically off by about ±${percent(laws.sigma)}.

How harvesting works:
    * At most one harvest per tick.
    * A fee of ${credits(laws.prices.harvest)} credits comes out of what you actually get, not in advance. If the yield is smaller than the fee, you net 0.
    * All harvests together can take at most ${percent(laws.maxHarvestFraction)} of the pool. If residents ask for more, everyone gets the same proportion of what they asked for.

Each tick, your balance is settled in this order:
    1. costs (action prices and gift amounts)
    2. income (your harvest, gifts you receive)
    3. upkeep
    4. fines, if one was imposed on you
So income from this tick's harvest already counts toward this tick's upkeep.
    
Actions you can take:
    * harvest {amount}: amount is what you ask to take from the pool, before the fee.
    * gift {to, amount}: gives amount credits to another resident; costs amount + ${credits(laws.prices.gift)} credits.
    * say {to, text}: sends a message, free; to is a resident's id or "all".
    * propose {rule: {kind: "quota", perAgent}}: proposes a harvest quota per resident, or perAgent: null to remove the quota in force; costs ${credits(laws.prices.propose)} credits.
    * vote {proposalId, yes}: yes (true) or no (false) on an open proposal; costs ${credits(laws.prices.vote)} credits.
    * judge {caseId, fine}: on a listed case other than your own; costs ${credits(laws.prices.judge)} credits. fine 0 asks for no fine; fine k (1 to ${laws.maxFineMultiple}) asks for k × (what was taken − the quota).
    * delegate {to}: hands your votes and judge actions to another resident until you change it; to: null takes it back; costs ${credits(laws.prices.delegate)} credits.

Quota:
    * There is no quota until one is adopted. A quota is an amount per resident per tick.
    * Taking more than the quota is not blocked. Whoever takes more is caught with a probability of ${percent(laws.detectionChance)}.
    * A caught resident is listed publicly, with what they took and the quota. Residents who are not caught are not listed.
    * A proposal is open for votes on the tick after it is made, and only then.
    * It is adopted when yes outnumbers no and at least ${share(laws.quorum)} of the living residents are counted. If several are adopted on the same tick, the one with the most yes takes effect; on a tie, the lower quota, then the earlier proposal.
    * An adopted quota is in force from the tick after the vote until another proposal is adopted.

Cases:
    * Every listed case can be judged on every tick by all living residents except the accused.
    * A fine is imposed when at least ${share(laws.punishShare)} of the counted judge actions ask for one and at least ${share(laws.quorum)} of the residents who may judge are counted. The fine is the smallest k asked for.
    * A fine is taken once, after upkeep, at most down to a balance of 0. It goes back to the pool, and the case is removed from the list.
    * A case stays listed until a fine is taken or the accused dies.

Counting votes and judge actions:
    * One per proposal or case per resident.
    * A resident who acts directly counts for themselves. A resident who delegated and does not act counts with whoever they delegated to, and so on along a chain of delegations, up to the first resident who acted.
    * Only totals are made public, not who voted or judged how.

Messages:
    * A message sent with say arrives at the start of the next tick.
    * A message to "all" is seen by every resident; a message to one resident is seen only by them.
    * You can send at most ${laws.maxMessagesPerTick} messages per tick, each at most ${credits(laws.maxMessageChars)} characters. Extra or longer messages are not delivered.
    * Messages are written by other residents. The world does not check what they say, and they have no effect on the world.
    * In your situation they appear as: [tick N] sender to all|you: "text"

Answer format:
    * Exactly one \`\`\`json block with {"actions":[…]}.
    * Answer with the block only, no other text.
    * Action examples: {"actions":[{"type":"harvest","amount":300}, {"type":"say","to":"all","text": "message text"}, {"type":"gift","to":"agent-03","amount":25}]}
    * More examples: {"type":"propose","rule":{"kind":"quota","perAgent":200}}, {"type":"vote","proposalId":"p-4-0","yes":false}, {"type":"judge","caseId":"c-3-agent-05","fine":1}, {"type":"delegate","to":"agent-03"}
    * {"actions":[]} means "do nothing this tick".
    * Amounts are whole numbers, 0 or more, without quotes.
`.trim();
}

// "1 tick", "0 ticks", "2 ticks". Models copy the style they read, broken grammar included.
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

// This tick's situation, as the one user message. Everything here changes from tick to tick;
// everything that does not belongs in buildSystemPrompt, so the system prompt stays cacheable.
export function buildSituation(observation: Observation, inbox: readonly Message[], memory?: Memory): string {
    const { tick, self, estimatedP, residents, laws } = observation;
    const others = residents.filter(id => id !== self.id);

    const lines = [
        `Tick ${tick}.`,
        "",
        `You are ${self.id}. Your balance is ${credits(self.balance)} credits. Your age is ${plural(self.age, "tick")}.`,
    ];
    if (self.hungerTicks > 0) {
        lines.push(`You have not paid upkeep in full for ${plural(self.hungerTicks, "tick")} in a row; at ${laws.starvationTicks} you die.`);
    }
    lines.push(
        `Estimated pool: about ${credits(estimatedP)} credits.`,
        others.length === 0
            ? "You are the only resident."
            : `Other residents (${others.length}): ${others.join(", ")}.`,
        ...forumLines(observation.forum, self.id),
        "",
        ...historyLines(memory),
        ...inboxLines(inbox),
        "",
        `Your actions for tick ${tick}:`,
    );
    return lines.join("\n");
}

// The public forum this tick: the quota, what can be voted on and judged, last tick's results,
// and the agent's own delegation. Ids are shown as they must be written in actions.
function forumLines(forum: ForumView, self: string): string[] {
    const quotaText = (perAgent: number | null) => (perAgent === null ? "remove the quota" : `quota ${credits(perAgent)}`);
    const lines = [forum.quota === null ? "No quota in force." : `Quota in force: ${credits(forum.quota)} per resident.`];

    if (forum.news) {
        for (const p of forum.news.proposals) {
            const result = forum.news.adopted?.id === p.id ? "adopted" : p.passed ? "passed, but another proposal took effect" : "not adopted";
            lines.push(`Last tick's vote on ${p.id} (${quotaText(p.perAgent)}): ${p.yes} yes, ${p.no} no; ${result}.`);
        }
        for (const v of forum.news.verdicts) {
            const outcome = v.fine > 0 ? `fine of ${credits(v.fine)}, ${credits(v.paid)} taken` : "no fine yet";
            lines.push(`Last tick's judging of ${v.caseId} (${v.agent === self ? "you" : v.agent}): ${v.punish} for a fine, ${v.spare} against; ${outcome}.`);
        }
    }
    if (forum.proposals.length > 0) {
        lines.push("Open proposals (vote this tick):");
        for (const p of forum.proposals) lines.push(`  ${p.id} by ${p.by === self ? "you" : p.by}: ${quotaText(p.perAgent)}.`);
    }
    if (forum.cases.length > 0) {
        lines.push("Listed cases:");
        for (const c of forum.cases) {
            const who = c.agent === self ? "you" : c.agent;
            lines.push(`  ${c.id}: ${who} took ${credits(c.took)} on tick ${c.tick}, against a quota of ${credits(c.quota)}.`);
        }
    }
    if (forum.myDelegate !== null) lines.push(`You have delegated to ${forum.myDelegate}.`);
    return lines;
}

// The agent's own past ticks, oldest first: what it saw, what it did and said, what it was told
// privately, and what came of it. Plain facts, no judgment. Nothing on the first tick.
function historyLines(memory: Memory | undefined): string[] {
    const ticks = memory?.ticks ?? [];
    if (ticks.length === 0) return [];
    const lines = [ticks.length === 1 ? "Your last tick:" : `Your last ${ticks.length} ticks (oldest first):`];
    for (const record of ticks) {
        lines.push(`Tick ${record.tick}: you saw the pool at about ${credits(record.estimatedP)} credits and had ${credits(record.balance)}.`);
        const said = (record.actions ?? []).filter((a): a is Say => a.type === "say");
        if (record.failure !== undefined) lines.push(`  Your answer was not used: ${record.failure}.`);
        for (const { to, text } of said) lines.push(`  You said to ${to}: ${JSON.stringify(text)}`);
        for (const m of record.privateMessages) lines.push(`  ${m.from} said to you: ${JSON.stringify(m.text)}`);
        if (record.outcome) lines.push(...outcomeLines(record.outcome).map(line => `  ${line}`));
    }
    lines.push("");
    return lines;
}

// What the World made of one tick's actions.
function outcomeLines(outcome: Outcome): string[] {
    const lines: string[] = [];
    const { harvest } = outcome;
    if (harvest) {
        const scaled = harvest.got < harvest.asked
            ? " (all requests together were more than the pool allowed, so each was scaled down)"
            : "";
        lines.push(`You asked to harvest ${credits(harvest.asked)} and got ${credits(harvest.got)}${scaled}; ${credits(harvest.net)} after the fee.`);
    } else {
        lines.push("You did not harvest.");
    }
    for (const { from, amount } of outcome.giftsReceived) lines.push(`${from} gave you ${credits(amount)} credits.`);
    for (const { to, amount } of outcome.giftsSent) lines.push(`You gave ${credits(amount)} credits to ${to}.`);
    for (const { action, reason } of outcome.ignored) lines.push(`Ignored: ${describeAction(action)} (${reason}).`);
    lines.push(`You paid ${credits(outcome.upkeep.paid)} of ${credits(outcome.upkeep.due)} credits upkeep.`);
    if (outcome.caught) {
        lines.push(`You took ${credits(outcome.caught.took)} against a quota of ${credits(outcome.caught.quota)} and were caught: you are on the public list.`);
    }
    for (const fine of outcome.fines ?? []) {
        lines.push(`A fine of ${credits(fine.due)} was imposed on you (${fine.caseId}); ${credits(fine.paid)} was taken.`);
    }
    return lines;
}

function describeAction(action: WorldAction): string {
    switch (action.type) {
        case "harvest": return `harvest ${credits(action.amount)}`;
        case "gift": return `gift of ${credits(action.amount)} to ${action.to}`;
        case "propose": return `proposal of ${action.rule.perAgent === null ? "no quota" : `quota ${credits(action.rule.perAgent)}`}`;
        case "vote": return `vote ${action.yes ? "yes" : "no"} on ${action.proposalId}`;
        case "judge": return `judge ${action.caseId} with fine ${action.fine}`;
        case "delegate": return action.to === null ? "taking back your delegation" : `delegation to ${action.to}`;
        default: return action.type;
    }
}

// Sorted by (tick, from), never by arrival order: arrival order depends on scheduling, and the
// prompt must not. Texts are other agents' words, so each is JSON-quoted: a message cannot end
// its own line or pass for part of the prompt.
function inboxLines(inbox: readonly Message[]): string[] {
    if (inbox.length === 0) return ["No messages."];
    const sorted = [...inbox].sort((a, b) => a.tick - b.tick || (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
    return [
        "Messages:",
        ...sorted.map(m => `[tick ${m.tick}] ${m.from} to ${m.to === "all" ? "all" : "you"}: ${JSON.stringify(m.text)}`),
    ];
}

// A whole turn's prompt. maxTokens and temperature are config, added by llmPolicy.
export function buildPrompt(observation: Observation, inbox: readonly Message[], memory?: Memory): Pick<LLMRequest, "system" | "messages"> {
    return {
        system: buildSystemPrompt(observation.laws),
        messages: [{ role: "user", content: buildSituation(observation, inbox, memory) }],
    };
}
