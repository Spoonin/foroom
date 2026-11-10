// runner.ts — see STEPS.md, step 2, "Tick protocol".
//
// The tick loop: observe → tick every Citizen → wait for submits (turn deadline) → resolve →
// record in the Ledger → stop the dead. Runner is plain async code, not an actor: it owns time
// and the actors' lifecycle, and nothing else needs to message it.
//
// Supervision:
//   - World, Ledger and TurnCollector run under the root supervisor with "escalate". A crash in
//     any of them is a bug that makes the run meaningless, so it fails the run.
//   - Citizens run under one child supervisor with "resume" (scope "one", so a crash never
//     touches the other citizens): the state is kept and the crashed message is dropped. A
//     crashed tick then simply never submits, and shows up in the Ledger as a timeout. A dead
//     citizen is stopped through that supervisor with stopChild.

import { Supervisor, type Crash } from "@cue/core";
import type { AgentId, Laws, Policy, Report, Tick, WorldAction } from "../contracts";
import { laws as defaultLaws } from "../config";
import { spawnCitizen, type CitizenRef } from "../agents/citizen";
import { createWorld, spawnWorld } from "./world";
import { eventsFromReport, readAll, record, spawnLedger, type LedgerEvent } from "./ledger";
import { spawnTurnCollector } from "./turnCollector";

export interface CitizenSpec {
    id: AgentId;
    policy: Policy;
}

export interface RunOptions {
    seed: number;
    ticks: number;
    citizens: readonly CitizenSpec[];
    laws?: Readonly<Laws>;
    start?: Parameters<typeof createWorld>[3]; // initial P, balance, lifespan
    // How long Runner waits for all submits. Late agents get an empty turn and a `timeout` event.
    turnDeadlineMs?: number;
    // Called after every tick, e.g. for console progress. Observer data: never give it to a policy.
    onTick?: (report: Report) => void;
    // Stops the run early, e.g. when a token budget is spent. One controller can stop many runs.
    // The run then returns normally with what it has, `aborted: true`. A tick in progress is
    // abandoned, not resolved: its unfinished agents would otherwise show up as false timeouts.
    signal?: AbortSignal;
}

export interface RunResult {
    events: LedgerEvent[];
    ticksRun: number; // resolved ticks only
    survivors: AgentId[];
    collapsed: boolean;
    aborted: boolean;
}

export const DEFAULT_TURN_DEADLINE_MS = 60_000;

export async function runSimulation(options: RunOptions): Promise<RunResult> {
    const { seed, ticks, citizens: specs, laws = defaultLaws, start, turnDeadlineMs = DEFAULT_TURN_DEADLINE_MS, signal } = options;

    const crashes: Crash[] = [];
    const system = new Supervisor({ onError: (crash) => { crashes.push(crash); } }, { policy: "escalate" });
    const failIfCrashed = () => {
        const [crash] = crashes;
        if (crash) throw new Error(`${crash.childId} crashed`, { cause: crash.error });
    };

    const world = spawnWorld(system, createWorld(seed, specs.map(s => s.id), laws, start), laws);
    const ledger = spawnLedger(system);
    const collector = spawnTurnCollector(system);

    const citizenSupervisor = system.spawnSupervisor({ policy: "resume" });
    const citizens = new Map<AgentId, CitizenRef>();
    for (const { id, policy } of specs) {
        citizens.set(id, spawnCitizen(citizenSupervisor, id, policy));
    }

    let ticksRun = 0;
    let collapsed = false;
    try {
        while (ticksRun < ticks && citizens.size > 0 && !signal?.aborted) {
            const observations = await world.call({ type: "observe" });
            const expected = [...observations.keys()]; // sorted by id (observe sorts)
            if (expected.length === 0) break; // everyone is dead
            // The World's tick, the same number every Citizen sees: submits for any other tick are dropped.
            const tick: Tick = observations.get(expected[0]!)!.tick;

            const complete = new Promise<void>(resolve => {
                collector.cast({ type: "open", tick, expected, onComplete: resolve });
            });
            for (const [id, observation] of observations) {
                citizens.get(id)?.cast({ type: "tick", observation, replyTo: collector });
            }
            await waitForTurn(complete, turnDeadlineMs, signal);
            if (signal?.aborted) break; // abandon this tick: nothing of it reaches the World or the Ledger
            const submitted = await collector.call({ type: "close", tick });

            // Every living agent gets a turn: a missing submit is an empty one.
            const submissions = new Map<AgentId, WorldAction[]>();
            const runnerEvents: LedgerEvent[] = [];
            for (const id of expected) {
                const submit = submitted.get(id);
                submissions.set(id, submit?.actions ?? []);
                if (!submit) runnerEvents.push({ tick, kind: "timeout", agent: id });
                else if (submit.error !== undefined) runnerEvents.push({ tick, kind: "policyFailed", agent: id, reason: submit.error });
            }

            const report = await world.call({ type: "resolve", submissions });
            record(ledger, [...eventsFromReport(report), ...runnerEvents]);

            for (const id of report.dead.keys()) {
                const ref = citizens.get(id);
                if (ref) citizenSupervisor.stopChild(ref);
                citizens.delete(id);
            }
            collapsed = report.collapsed;
            ticksRun++;
            failIfCrashed();
            options.onTick?.(report);
        }
        const events = await readAll(ledger);
        failIfCrashed();
        return { events, ticksRun, survivors: [...citizens.keys()].sort(), collapsed, aborted: signal?.aborted ?? false };
    } finally {
        system.stop();
    }
}

// Resolves when `done` resolves, after `ms`, or on abort, whichever comes first. Leaves nothing
// behind: the timer is cleared, and the abort listener removed, because one signal can be shared by
// many runs and live for thousands of ticks.
async function waitForTurn(done: Promise<void>, ms: number, signal?: AbortSignal): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const deadline = new Promise<void>(resolve => { timer = setTimeout(resolve, ms); });
    const aborted = new Promise<void>(resolve => {
        onAbort = resolve;
        signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
        await Promise.race([done, deadline, aborted]);
    } finally {
        clearTimeout(timer);
        if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
}
