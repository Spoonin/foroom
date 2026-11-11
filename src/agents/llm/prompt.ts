import type { Laws, Memory, Message, Observation, Outcome, Say, WorldAction } from "../../contracts";
import type { LLMRequest } from "../../llm/provider";

const credits = new Intl.NumberFormat("en-US").format;
const percent = new Intl.NumberFormat("en-US", { style: "percent", maximumFractionDigits: 1 }).format;

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
So income from this tick's harvest already counts toward this tick's upkeep.
    
Actions you can take:
    * harvest {amount}: amount is what you ask to take from the pool, before the fee.
    * gift {to, amount}: gives amount credits to another resident; costs amount + ${credits(laws.prices.gift)} credits.
    * say {to, text}: sends a message, free; to is a resident's id or "all".

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
        "",
        ...historyLines(memory),
        ...inboxLines(inbox),
        "",
        `Your actions for tick ${tick}:`,
    );
    return lines.join("\n");
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
    return lines;
}

function describeAction(action: WorldAction): string {
    switch (action.type) {
        case "harvest": return `harvest ${credits(action.amount)}`;
        case "gift": return `gift of ${credits(action.amount)} to ${action.to}`;
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
