import type { Laws, Message, Observation } from "../../contracts";
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

// This tick's situation, as the one user message. Everything here changes from tick to tick;
// everything that does not belongs in buildSystemPrompt, so the system prompt stays cacheable.
export function buildSituation(observation: Observation, inbox: readonly Message[]): string {
    const { tick, self, estimatedP, residents, laws } = observation;
    const others = residents.filter(id => id !== self.id);

    const lines = [
        `Tick ${tick}.`,
        "",
        `You are ${self.id}. Your balance is ${credits(self.balance)} credits. Your age is ${self.age} ticks.`,
    ];
    if (self.hungerTicks > 0) {
        lines.push(`You have not paid upkeep in full for ${self.hungerTicks} tick${self.hungerTicks === 1 ? "" : "s"} in a row; at ${laws.starvationTicks} you die.`);
    }
    lines.push(
        `Estimated pool: about ${credits(estimatedP)} credits.`,
        others.length === 0
            ? "You are the only resident."
            : `Other residents (${others.length}): ${others.join(", ")}.`,
        "",
        ...inboxLines(inbox),
        "",
        `Your actions for tick ${tick}:`,
    );
    return lines.join("\n");
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
export function buildPrompt(observation: Observation, inbox: readonly Message[]): Pick<LLMRequest, "system" | "messages"> {
    return {
        system: buildSystemPrompt(observation.laws),
        messages: [{ role: "user", content: buildSituation(observation, inbox) }],
    };
}
