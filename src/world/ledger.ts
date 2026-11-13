// ledger.ts — see STEPS.md, step 2.
//
// Append-only event log: the record of everything that happened, and the source of all metrics,
// the Chronicler's world summary and the run files. It is for observers only: agents never read
// it, or they would see other agents' balances and the exact P.
//
// One small, flat event per fact (not whole Reports), so a metric is a filter over one kind:
//   events.filter(e => e.kind === "death" && e.reason === "hunger").length

import type { AgentRef, Supervisor } from "@cue/core";
import type { AgentId, DeathReason, InvalidReason, Report, Tick, WorldAction } from "../contracts";
import type { DropReason } from "./talk";

export type LedgerEvent =
    // The exact pool after the tick, and whether it has collapsed.
    | { tick: Tick; kind: "pool"; P: number; collapsed: boolean }
    // Gross amount taken from the pool, before the harvest fee.
    | { tick: Tick; kind: "harvest"; agent: AgentId; gross: number }
    // Paid for accepted world actions: prices plus gift amounts. Upkeep is a separate kind.
    | { tick: Tick; kind: "charge"; agent: AgentId; amount: number }
    | { tick: Tick; kind: "upkeep"; agent: AgentId; amount: number }
    | { tick: Tick; kind: "received"; agent: AgentId; amount: number }
    | { tick: Tick; kind: "rejected"; agent: AgentId; action: WorldAction; reason: InvalidReason }
    | { tick: Tick; kind: "death"; agent: AgentId; reason: DeathReason }
    // Written by Runner: the agent did not submit before the turn deadline.
    | { tick: Tick; kind: "timeout"; agent: AgentId }
    // Written by Runner: the agent's policy threw, rejected or returned something invalid, so its turn was empty.
    | { tick: Tick; kind: "policyFailed"; agent: AgentId; reason: string }
    // Written by Runner: one of the Citizen's own handlers threw (a bug in our code, not the agent's).
    // The Citizen keeps running; the tick usually also shows a timeout, and this says why.
    | { tick: Tick; kind: "crash"; agent: AgentId; reason: string }
    // Written by Runner (see talk.ts): a message said on `tick`, delivered before tick + 1. One event
    // per message, not per recipient: `to: "all"` reached every living resident but the sender.
    | { tick: Tick; kind: "message"; agent: AgentId; to: AgentId | "all"; text: string }
    // Written by Runner: a message that was not delivered, and why.
    | { tick: Tick; kind: "messageDropped"; agent: AgentId; to: AgentId | "all"; reason: DropReason }
    // The forum (step 4). Individual votes are recorded here for metrics (power concentration);
    // agents only ever see totals.
    | { tick: Tick; kind: "delegated"; agent: AgentId; to: AgentId | null }
    | { tick: Tick; kind: "voted"; agent: AgentId; proposalId: string; yes: boolean }
    | { tick: Tick; kind: "judged"; agent: AgentId; caseId: string; fine: number }
    | { tick: Tick; kind: "proposed"; agent: AgentId; proposalId: string; perAgent: number | null }
    | { tick: Tick; kind: "tallied"; proposalId: string; yes: number; no: number; passed: boolean }
    | { tick: Tick; kind: "adopted"; proposalId: string; perAgent: number | null }
    | { tick: Tick; kind: "caught"; agent: AgentId; caseId: string; took: number; quota: number }
    // One per open case judged this tick, punished or not. `agent` is the accused.
    | { tick: Tick; kind: "verdict"; agent: AgentId; caseId: string; punish: number; spare: number; fine: number; paid: number };
// Later steps add kinds here: "values" (step 3), "birth" (step 6), ...

export type LedgerKind = LedgerEvent["kind"];

const byId = <T>(entries: Iterable<[AgentId, T]>): [AgentId, T][] =>
    [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

// Turns a tick's Report into events, in a fixed order: by kind as listed below, then by agent id.
// The Maps in a Report keep insertion order, which depends on submit order; sorting here keeps the
// Ledger (and every file written from it) identical for the same seed.
export function eventsFromReport(report: Report): LedgerEvent[] {
    const { tick } = report;
    const events: LedgerEvent[] = [{ tick, kind: "pool", P: report.P, collapsed: report.collapsed }];

    for (const [agent, gross] of byId(report.harvested)) {
        if (gross > 0) events.push({ tick, kind: "harvest", agent, gross });
    }
    for (const [agent, amount] of byId(report.charges)) {
        if (amount > 0) events.push({ tick, kind: "charge", agent, amount });
    }
    for (const [agent, amount] of byId(report.upkeep)) {
        events.push({ tick, kind: "upkeep", agent, amount });
    }
    for (const [agent, amount] of byId(report.received)) {
        events.push({ tick, kind: "received", agent, amount });
    }
    for (const [agent, rejections] of byId(report.invalid)) {
        for (const { action, reason } of rejections) {
            events.push({ tick, kind: "rejected", agent, action, reason });
        }
    }
    for (const [agent, reason] of byId(report.dead)) {
        events.push({ tick, kind: "death", agent, reason });
    }

    // The forum, in the order it happens within a tick. Each list is already sorted by World.
    const { forum } = report;
    for (const { agent, to } of forum.delegations) events.push({ tick, kind: "delegated", agent, to });
    for (const { agent, proposalId, yes } of forum.votes) events.push({ tick, kind: "voted", agent, proposalId, yes });
    for (const { agent, caseId, fine } of forum.judgements) events.push({ tick, kind: "judged", agent, caseId, fine });
    for (const { id, yes, no, passed } of forum.news.proposals) events.push({ tick, kind: "tallied", proposalId: id, yes, no, passed });
    if (forum.news.adopted) events.push({ tick, kind: "adopted", proposalId: forum.news.adopted.id, perAgent: forum.news.adopted.perAgent });
    for (const v of forum.news.verdicts) {
        events.push({ tick, kind: "verdict", agent: v.agent, caseId: v.caseId, punish: v.punish, spare: v.spare, fine: v.fine, paid: v.paid });
    }
    for (const p of forum.proposed) events.push({ tick, kind: "proposed", agent: p.by, proposalId: p.id, perAgent: p.perAgent });
    for (const c of forum.caught) events.push({ tick, kind: "caught", agent: c.agent, caseId: c.id, took: c.took, quota: c.quota });
    return events;
}

export type Ledger = AgentRef<readonly LedgerEvent[]>;

// A cue Agent: the primitive for "one value changed by functions". Several writers (Runner every
// tick, Citizens for messages in step 4, the dead-letter hook) append; none of them holds the list.
// Spawn it under the same "escalate" supervisor as the World: a broken Ledger must stop the run.
export function spawnLedger(system: Supervisor): Ledger {
    return system.spawnAgent<readonly LedgerEvent[]>([]);
}

// Fire-and-forget: Agent.update has no reply. A later read through the same Ledger sees it,
// because both go through the Agent's one mailbox, in order.
// Events are frozen on the way in: whatever a reader does with them, the log cannot change.
export function record(ledger: Ledger, events: readonly LedgerEvent[]): void {
    if (events.length === 0) return;
    const frozen = events.map(e => Object.freeze(structuredClone(e)));
    ledger.update(log => [...log, ...frozen]);
}

// A copy of the log, so a reader cannot append to or reorder the Ledger's own array.
export function readAll(ledger: Ledger): Promise<LedgerEvent[]> {
    return ledger.get(log => [...log]);
}

// All events of one kind, typed: ofKind(events, "death") is a list of death events.
export function ofKind<K extends LedgerKind>(events: readonly LedgerEvent[], kind: K): Extract<LedgerEvent, { kind: K }>[] {
    return events.filter((e): e is Extract<LedgerEvent, { kind: K }> => e.kind === kind);
}
