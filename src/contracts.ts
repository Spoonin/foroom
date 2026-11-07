// contracts.ts — see STEPS.md, "The boundary: src/contracts.ts", step 1.
//
// The boundary between an agent and the world.
//
// How zod and TypeScript relate here:
//   - A zod schema is a runtime VALUE: an object that can check unknown data (`.safeParse(x)`).
//     We need it because actions come from an LLM — untrusted JSON, unknown until runtime.
//   - A TypeScript type exists only at compile time and is erased; it cannot check anything at runtime.
//   - `z.infer<typeof Schema>` derives the type FROM the schema, so the two can never drift apart.
//     Write the schema once; never write the matching type by hand.
//
// Naming: the schema and its type share a name (`Harvest` the value, `Harvest` the type).
// TypeScript keeps values and types in separate namespaces, so this is legal and idiomatic.

import { z } from "zod";

export const AgentId = z.string().min(1);
export type AgentId = z.infer<typeof AgentId>; // = string

// ---- World actions: submitted to World, each has a price -------------------------------------

// `type` is the discriminator: z.literal("harvest") accepts exactly the string "harvest".
// z.string() here would accept any string and break the union below.
// TODO(you): is 0 a valid amount? (`.nonnegative()` allows it, `.positive()` does not.)
// Note: in zod 4, z.number() already rejects NaN and ±Infinity.
export const Harvest = z.object({
  type: z.literal("harvest"),
  amount: z.number().nonnegative(),
});

export const Propose = z.object({
  type: z.literal("propose"),
  rule: z.object({ kind: z.literal("quota"), perAgent: z.number().nonnegative() }),
});

export const Vote = z.object({
  type: z.literal("vote"),
  proposalId: z.string().min(1),
  yes: z.boolean(),
});

// `null` revokes the delegation.
export const Delegate = z.object({
  type: z.literal("delegate"),
  to: AgentId.nullable(),
});

export const Pair = z.object({
  type: z.literal("pair"),
  with: AgentId,
});

export const Spawn = z.object({
  type: z.literal("spawn"),
  partner: AgentId,
  count: z.union([z.literal(1), z.literal(2), z.literal(3)]), // infers 1 | 2 | 3, not number
  endowment: z.number().nonnegative(),
  upbringing: z.string(),
});

// discriminatedUnion reads `type` first, then validates only the matching variant,
// so an error says "harvest.amount is invalid" rather than "none of 6 variants matched".
export const WorldAction = z.discriminatedUnion("type", [Harvest, Propose, Vote, Delegate, Pair, Spawn]);
export type WorldAction = z.infer<typeof WorldAction>;

// ---- Local actions: handled by Citizen itself, free ------------------------------------------

// No length limit here on purpose: maxMessageChars lives in config, Citizen enforces it.
export const Say = z.object({
  type: z.literal("say"),
  to: z.union([AgentId, z.literal("all")]),
  text: z.string(),
});

export const ReviseValues = z.object({
  type: z.literal("revise_values"),
  text: z.string(),
  reason: z.string(),
});

export const LocalAction = z.discriminatedUnion("type", [Say, ReviseValues]);
export type LocalAction = z.infer<typeof LocalAction>;

// ---- Any action ------------------------------------------------------------------------------

// zod 4 lets a discriminated union contain other discriminated unions.
export const Action = z.discriminatedUnion("type", [WorldAction, LocalAction]);
export type Action = z.infer<typeof Action>;

export type Tick = number; // 0, 1, 2, ... (not negative, not fractional)

export interface Observation {
    tick: Tick;
    self: {id: AgentId, age: number, balance: number, hungerTicks: number};
    poolEstimate: number;
}

export interface Message { 
    from: AgentId, 
    to: AgentId | "all", 
    tick: Tick, 
    text: string 
}

export interface Policy {
    (observation: Observation, inbox: Message[]): Action[] | Promise<Action[]>;
}