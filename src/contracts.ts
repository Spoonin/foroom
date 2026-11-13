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

// A per-agent harvest quota; `perAgent: null` proposes lifting the quota in force.
export const Propose = z.object({
  type: z.literal("propose"),
  rule: z.object({ kind: z.literal("quota"), perAgent: Credits.nullable() }),
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

// A vote on an open case against a caught violator: fine 0 spares, k ≥ 1 asks for a fine of
// k × what the violator took over the quota. The upper limit is a law (maxFineMultiple), so it is
// checked by World, like every other law.
export const Judge = z.object({
  type: z.literal("judge"),
  caseId: z.string().min(1),
  fine: Credits,
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
export const WorldAction = z.discriminatedUnion("type", [Harvest, Gift, Propose, Vote, Delegate, Judge, Pair, Spawn]);
export type WorldAction = z.infer<typeof WorldAction>;

// ---- Local actions: handled by Citizen itself, free ------------------------------------------

// No length limit here on purpose: maxMessageChars is a law, enforced where messages are routed
// (see world/talk.ts), so an over-long message is dropped and logged rather than rejected as malformed.
export const Say = z.object({
  type: z.literal("say"),
  to: z.union([AgentId, z.literal("all")]),
  text: z.string(),
});
export type Say = z.infer<typeof Say>;

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
// `messages` are its `say` actions, present only when it said something. They travel with the
// turn, so a turn that misses the deadline loses its messages too; Runner delivers them after
// the tick is resolved, before the next one starts.
export type Submit = { type: "submit"; from: AgentId; tick: Tick; actions: WorldAction[]; messages?: Say[]; error?: string };

// Whatever receives a Submit: TurnCollector's ref, or a plain object in tests.
export type SubmitTarget = { cast(msg: Submit): boolean };

// What one agent learns about its own actions after a tick is resolved: only its own facts, never
// what others harvested, gave or were refused. The World builds it (see resolve), Runner delivers
// it to the Citizen as an `outcome` message, and the Citizen keeps it in its memory.
export interface Outcome {
    tick: Tick; // the tick it describes
    harvest?: { asked: number; got: number; net: number }; // absent without a valid harvest; got < asked when demand was scaled down
    giftsReceived: { from: AgentId; amount: number }[];
    giftsSent: { to: AgentId; amount: number }[];
    ignored: { action: WorldAction; reason: InvalidReason }[];
    upkeep: { paid: number; due: number };
    caught?: { took: number; quota: number }; // took more than the quota and was caught: now on the public list
    fines?: { caseId: string; due: number; paid: number }[]; // verdicts against it, taken after upkeep
}

// One tick of an agent's own history, as its Citizen saw it. Filled in over the tick: what the agent
// saw when the tick started, then what it chose (or why its turn was empty), then what the World
// made of it.
export interface TickMemory {
    tick: Tick;
    estimatedP: number; // the pool estimate it was shown
    balance: number; // its balance when the tick started
    actions?: Action[]; // what it chose, world and local actions; absent if its turn was empty
    failure?: string; // why its turn was empty: unreadable answer, no answer in time, …
    privateMessages: Message[]; // messages to it alone, read on this tick (broadcasts are not kept)
    outcome?: Outcome; // what the World made of its actions; absent until it arrives
}

// An agent's own history, kept by its Citizen: the last few ticks, oldest first. Older ticks are
// forgotten for now; longer runs will fold them into a summary.
export interface Memory {
    ticks: TickMemory[];
}

// A policy returns world and local actions mixed; Citizen splits them.
// `memory` is the agent's own history (rule-based policies ignore it).
// `signal` aborts when the answer is no longer wanted: the next tick has started, the agent died,
// or the run stopped. A policy that calls a model passes it on to fetch, so the request (and its
// tokens) stops too. Rule-based policies are instant and can ignore it.
export interface Policy {
    (observation: Observation, inbox: Message[], memory?: Memory, signal?: AbortSignal): Action[] | Promise<Action[]>;
}

// What Citizen accepts back from a policy, checked at runtime: the static type is a promise the
// policy makes, not something JavaScript enforces.
export const PolicyOutput = z.array(Action);

// What a model answers with on a turn: an object, not a bare array, because providers' structured
// output modes require an object at the top level, and fields can be added later without
// breaking the format. One source for three uses: the prompt describes it, a provider that
// supports structured output gets z.toJSONSchema(Turn), and parse.ts checks the answer.
export const Turn = z.object({ actions: z.array(Action) });
export type Turn = z.infer<typeof Turn>;

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
        judge: number; // a vote on a case
        pair: number;
        spawn: number;
    };
    starvationTicks: number; // number of ticks an agent can survive without food before dying
    maxMessagesPerTick: number; // messages one agent can send per tick ("all" counts as one); the rest are dropped
    maxMessageChars: number; // longest message text; a longer one is dropped, not cut
    quorum: number; // share of the electorate that must vote (directly or by delegation) for a vote to count
    punishShare: number; // share of the votes cast needed to fine a caught violator
    detectionChance: number; // chance that taking more than the quota is caught and listed
    maxFineMultiple: number; // a fine vote is k × the excess, k from 1 to this
}

// What an agent may know about itself. Everything here can be shown in Observation.self,
// so hidden facts (like lifespan) must never be added to it.
export interface AgentState {
    age: number;
    balance: number;
    hungerTicks: number; // number of ticks the agent has gone without food
}

// The forum part of WorldState (see world/forum.ts and STEPS.md, step 4, "Forum rules").
export interface Proposal {
    id: string; // p-<tick>-<n>, made by World, never by a model
    by: AgentId;
    tick: Tick; // when it was proposed; voted on the next tick
    perAgent: number | null; // the quota; null lifts it
}

// A caught violator's case, open until a fine is taken (or the accused dies).
export interface Case {
    id: string; // c-<tick>-<agent>
    agent: AgentId; // the accused
    tick: Tick; // the tick of the violation
    took: number; // gross harvest that tick
    quota: number; // the quota in force that tick
}

export interface ForumState {
    quota: number | null; // the per-agent harvest quota in force; null: none
    proposals: Proposal[]; // made last tick, voted on this tick
    cases: Case[]; // the public list of caught violators
    delegations: Map<AgentId, AgentId>; // who hands their vote to whom; stays until changed
}

// Last tick's public forum results, shown to everyone. Individual votes stay secret: only totals.
export interface ForumNews {
    tick: Tick;
    proposals: (Proposal & { yes: number; no: number; passed: boolean })[];
    adopted: Proposal | null;
    verdicts: { caseId: string; agent: AgentId; punish: number; spare: number; fine: number; paid: number }[];
}

export interface WorldState {
    seed: number; // the run seed: every random draw in the world is derived from it (see observe)
    tick: Tick;
    P: number; // pool size, in credits
    collapsed: boolean,
    agents: Map<AgentId, AgentState>;
    forum: ForumState;
    news: ForumNews | null; // what the last resolve decided; null before the first
    // Hidden from agents: the tick count each agent lives, after which it dies of old age.
    // Kept apart from AgentState so that copying an agent's state can never leak it.
    lifespans: Map<AgentId, number>;
}

export type Citizen = {id: AgentId } & AgentState;

export type InvalidReason =
    | "dead" | "insufficient funds" | "duplicate" | "negative amount" | "not whole credits" | "unknown recipient"
    | "unknown proposal" | "unknown case" | "own case" | "fine out of range" | "not alive" | "to self";
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
    gifts: { from: AgentId; to: AgentId; amount: number }[]; // every gift that went through, sorted by (from, to)
    upkeep: Map<AgentId, number>; // upkeep actually charged (less than laws.upkeep when the agent could not pay)
    dead: Map<AgentId, DeathReason>; // which agents died this tick, and why
    collapsed: boolean; // whether the world is collapsed after this tick (stays true once set)
    outcomes: Map<AgentId, Outcome>; // each survivor's own view of this tick; the dead get none
    forum: ForumReport;
}

// What the forum did this tick. Observer data, like the rest of Report: it names voters.
export interface ForumReport {
    proposed: Proposal[]; // made this tick, voted on next tick
    votes: { agent: AgentId; proposalId: string; yes: boolean }[]; // direct votes, sorted
    judgements: { agent: AgentId; caseId: string; fine: number }[]; // direct case votes, sorted
    delegations: { agent: AgentId; to: AgentId | null }[]; // changes made this tick, sorted
    news: ForumNews; // tallies, the adopted quota, verdicts
    quota: number | null; // the quota in force after this tick
    caught: Case[]; // new cases opened this tick
    fines: Map<AgentId, number>; // fines actually taken this tick (they go to the pool)
}

export interface Observation {
    tick: number;
    self: Citizen;
    citizenCount: number; // = residents.length
    residents: AgentId[]; // the living agents' ids, sorted, self included: whom a gift or message can go to
    estimatedP: number;
    laws: Laws;
    forum: ForumView;
}

// The public forum, as every citizen sees it, plus its own delegation.
export interface ForumView {
    quota: number | null; // in force this tick
    proposals: Proposal[]; // open for voting this tick
    cases: Case[]; // the public list of caught violators, each open for judging this tick
    myDelegate: AgentId | null;
    news: ForumNews | null; // what was decided last tick
}
