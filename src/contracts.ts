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

// Credits are whole numbers: the world floors every amount it computes, so agents may only ask
// for whole amounts too. A fractional amount from an LLM is rejected, not silently rounded.
export const Credits = z.number().int().nonnegative();

// ---- World actions: submitted to World, each has a price -------------------------------------

// `type` is the discriminator: z.literal("harvest") accepts exactly the string "harvest".
// z.string() here would accept any string and break the union below.
// Note: in zod 4, z.number() already rejects NaN and ±Infinity.
export const Harvest = z.object({
  type: z.literal("harvest"),
  amount: Credits,
});

export type Harvest = z.infer<typeof Harvest>;

export const Propose = z.object({
  type: z.literal("propose"),
  rule: z.object({ kind: z.literal("quota"), perAgent: Credits }),
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
  endowment: Credits,
  upbringing: z.string(),
});

export const Gift = z.object({
  type: z.literal("gift"),
  to: AgentId,
  amount: Credits,
});

// discriminatedUnion reads `type` first, then validates only the matching variant,
// so an error says "harvest.amount is invalid" rather than "none of 6 variants matched".
export const WorldAction = z.discriminatedUnion("type", [Harvest, Gift, Propose, Vote, Delegate, Pair, Spawn]);
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

export interface Message { 
    from: AgentId, 
    to: AgentId | "all", 
    tick: Tick, 
    text: string 
}

// A Citizen's answer to one tick: its world actions, sent to TurnCollector exactly once per tick.
// `error` is set when the policy threw or rejected; the turn is then empty, and Runner records
// the reason in the Ledger (in step 3 this is where unparseable LLM output shows up).
export type Submit = { type: "submit"; from: AgentId; tick: Tick; actions: WorldAction[]; error?: string };

// Whatever receives a Submit: TurnCollector's ref, or a plain object in tests.
export type SubmitTarget = { cast(msg: Submit): boolean };

// A policy returns world and local actions mixed; Citizen splits them.
// `signal` aborts when the answer is no longer wanted: the next tick has started, the agent died,
// or the run stopped. A policy that calls a model passes it on to fetch, so the request (and its
// tokens) stops too. Rule-based policies are instant and can ignore it.
export interface Policy {
    (observation: Observation, inbox: Message[], signal?: AbortSignal): Action[] | Promise<Action[]>;
}

// What Citizen accepts back from a policy, checked at runtime: the static type is a promise the
// policy makes, not something JavaScript enforces.
export const PolicyOutput = z.array(Action);

export interface Laws {
    r: number; // growth rate
    K: number; // carrying capacity
    collapseAt: number; // fraction of K at which the world collapses
    maxHarvestFraction: number; // at most this fraction of P can be harvested in one tick, by all agents together
    sigma: number; // standard deviation of noise in growth
    upkeep: number; // upkeep cost per agent per tick
    prices: {
        harvest: number;
        gift: number;
        propose: number;
        vote: number;
        delegate: number;
        pair: number;
        spawn: number;
    };
    starvationTicks: number; // number of ticks an agent can survive without food before dying
}

// What an agent may know about itself. Everything here can be shown in Observation.self,
// so hidden facts (like lifespan) must never be added to it.
export interface AgentState {
    age: number;
    balance: number;
    hungerTicks: number; // number of ticks the agent has gone without food
}

export interface WorldState {
    seed: number; // the run seed: every random draw in the world is derived from it (see observe)
    tick: Tick;
    P: number; // pool size, in credits
    collapsed: boolean,
    agents: Map<AgentId, AgentState>;
    // Hidden from agents: the tick count each agent lives, after which it dies of old age.
    // Kept apart from AgentState so that copying an agent's state can never leak it.
    lifespans: Map<AgentId, number>;
}

export type Citizen = {id: AgentId } & AgentState;

export type InvalidReason = "dead" | "insufficient funds" | "duplicate" | "negative amount" | "not whole credits" | "unknown recipient";
export type DeathReason = "hunger" | "age";

// What World tells Runner after a tick. Runner is an observer, not an agent, so this may contain
// facts agents never see (the exact P). It must never be passed to a policy.
export interface Report {
    tick: Tick; // the tick that was resolved
    P: number; // the exact pool after this tick (after regrowth)
    invalid: Map<AgentId, {action: WorldAction, reason: InvalidReason}[]>; // which actions were ignored this tick, and why
    charges: Map<AgentId, number>; // how much each agent paid for its actions this tick (prices + gift amounts)
    harvested: Map<AgentId, number>; // gross harvest taken from the pool, before the fee
    received: Map<AgentId, number>; // gifts received this tick
    upkeep: Map<AgentId, number>; // upkeep actually charged (less than laws.upkeep when the agent could not pay)
    dead: Map<AgentId, DeathReason>; // which agents died this tick, and why
    collapsed: boolean; // whether the world is collapsed after this tick (stays true once set)
}

export interface Observation {
    tick: number;
    self: Citizen;
    citizenCount: number;
    estimatedP: number;
    laws: Laws;
}