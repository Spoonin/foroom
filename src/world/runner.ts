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
//     touches the other citizens): the state is kept and the crashed message is dropped. That
//     message becomes a dead letter, which Runner records as a `crash` event, so the Ledger says
//     why the citizen missed its turn instead of showing only a timeout.
//   - A dead citizen is stopped through that supervisor with stopChild, after its lifetime signal
//     is aborted so an in-flight policy call (a model request) stops too.

import { Supervisor, type Crash, type DeadLetter } from "@cue/core";
import type { AgentId, Laws, Policy, Report, Say, Tick, WorldAction } from "../contracts";
import { laws as defaultLaws } from "../config";
import { spawnCitizen, type CitizenMsg, type CitizenRef } from "../agents/citizen";
import { createWorld, spawnWorld } from "./world";
import { eventsFromReport, readAll, record, spawnLedger, type LedgerEvent } from "./ledger";
import { spawnTurnCollector } from "./turnCollector";
import { routeMessages } from "./talk";

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
    // After the pool collapses, the run goes on for this many more ticks and then stops: long
    // enough to see who survives the collapse, short of paying for a world that is already lost.
    // Infinity runs on to `ticks`.
    ticksAfterCollapse?: number;
}

export interface RunResult {
    events: LedgerEvent[];
    ticksRun: number; // resolved ticks only
    survivors: AgentId[];
    collapsed: boolean;
    aborted: boolean;
    collapsedAt: Tick | null; // the first tick after which the pool was collapsed
    endedBy: "ticks" | "collapse" | "extinction" | "aborted";
}

export const DEFAULT_TURN_DEADLINE_MS = 60_000;
export const DEFAULT_TICKS_AFTER_COLLAPSE = 10;

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export async function runSimulation(options: RunOptions): Promise<RunResult> {
    const { seed, ticks, citizens: specs, laws = defaultLaws, start, turnDeadlineMs = DEFAULT_TURN_DEADLINE_MS, signal,
        ticksAfterCollapse = DEFAULT_TICKS_AFTER_COLLAPSE } = options;

    // Citizen crashes, as Ledger events waiting to be recorded with the next batch.
    const crashEvents: LedgerEvent[] = [];
    const agentOfActor = new Map<string, AgentId>();

    const crashes: Crash[] = [];
    const system = new Supervisor(
        { onError: (crash) => { crashes.push(crash); } },
        {
            policy: "escalate",
            onDeadLetter: (letter) => {
                const event = crashEventOf(letter, actorId => agentOfActor.get(actorId));
                if (event) crashEvents.push(event);
            },
        },
    );
    const failIfCrashed = () => {
        const [crash] = crashes;
        if (crash) throw new Error(`${crash.origin} crashed: ${reasonOf(crash.error)}`, { cause: crash.error });
    };
    const takeCrashEvents = () => crashEvents.splice(0).sort(byTickThenAgent);

    const world = spawnWorld(system, createWorld(seed, specs.map(s => s.id), laws, start), laws);
    const ledger = spawnLedger(system);
    const collector = spawnTurnCollector(system);

    const citizenSupervisor = system.spawnSupervisor({ policy: "resume" });
    const citizens = new Map<AgentId, { ref: CitizenRef; lifetime: AbortController }>();
    for (const { id, policy } of specs) {
        const lifetime = new AbortController();
        const ref = spawnCitizen(citizenSupervisor, id, policy, { lifetime: lifetime.signal });
        citizens.set(id, { ref, lifetime });
        agentOfActor.set(ref.id, id);
    }

    let ticksRun = 0;
    let collapsed = false;
    let collapsedAt: Tick | null = null;
    let lastTick: Tick = -1;
    const pastCollapse = () => collapsedAt !== null && lastTick - collapsedAt >= ticksAfterCollapse;
    try {
        while (ticksRun < ticks && citizens.size > 0 && !signal?.aborted && !pastCollapse()) {
            const observations = await world.call({ type: "observe" });
            const expected = [...observations.keys()]; // sorted by id (observe sorts)
            if (expected.length === 0) break; // everyone is dead
            // The World's tick, the same number every Citizen sees: submits for any other tick are dropped.
            const tick: Tick = observations.get(expected[0]!)!.tick;

            const complete = new Promise<void>(resolve => {
                collector.cast({ type: "open", tick, expected, onComplete: resolve });
            });
            for (const [id, observation] of observations) {
                citizens.get(id)?.ref.cast({ type: "tick", observation, replyTo: collector });
            }
            await waitForTurn(complete, turnDeadlineMs, signal);
            if (signal?.aborted) break; // abandon this tick: nothing of it reaches the World or the Ledger
            const submitted = await collector.call({ type: "close", tick });

            // Every living agent gets a turn: a missing submit is an empty one.
            const submissions = new Map<AgentId, WorldAction[]>();
            const said = new Map<AgentId, Say[]>();
            const runnerEvents: LedgerEvent[] = [];
            for (const id of expected) {
                const submit = submitted.get(id);
                submissions.set(id, submit?.actions ?? []);
                if (submit?.messages) said.set(id, submit.messages);
                if (!submit) runnerEvents.push({ tick, kind: "timeout", agent: id });
                else if (submit.error !== undefined) runnerEvents.push({ tick, kind: "policyFailed", agent: id, reason: submit.error });
            }

            const report = await world.call({ type: "resolve", submissions });
            record(ledger, [...eventsFromReport(report), ...runnerEvents, ...takeCrashEvents()]);

            for (const id of report.dead.keys()) {
                const citizen = citizens.get(id);
                if (citizen) {
                    citizen.lifetime.abort(new Error(`${id} died`));
                    citizenSupervisor.stopChild(citizen.ref);
                }
                citizens.delete(id);
            }
            // Before the next tick starts: each survivor's mailbox then holds its messages and its
            // outcome ahead of the next `tick`, so the next policy call always sees what was said to
            // it and what happened this tick. Only the living receive.
            const { inboxes, events: talkEvents } = routeMessages(tick, said, [...citizens.keys()], laws);
            record(ledger, talkEvents);
            for (const [id, messages] of inboxes) {
                citizens.get(id)?.ref.cast({ type: "hear", messages });
            }
            for (const [id, outcome] of report.outcomes) {
                citizens.get(id)?.ref.cast({ type: "outcome", outcome });
            }
            collapsed = report.collapsed;
            if (collapsed && collapsedAt === null) collapsedAt = report.tick;
            lastTick = report.tick;
            ticksRun++;
            failIfCrashed();
            options.onTick?.(report);
        }
        record(ledger, takeCrashEvents()); // crashes after the last resolved tick
        const events = await readAll(ledger);
        failIfCrashed();
        const aborted = signal?.aborted ?? false;
        const endedBy: RunResult["endedBy"] =
            aborted ? "aborted" : citizens.size === 0 ? "extinction" : pastCollapse() ? "collapse" : "ticks";
        return { events, ticksRun, survivors: [...citizens.keys()].sort(), collapsed, aborted, collapsedAt, endedBy };
    } finally {
        // Abort first, so in-flight policy calls stop, then stop the actors.
        for (const { lifetime } of citizens.values()) lifetime.abort(new Error("the run ended"));
        system.stop();
    }
}

// A dead letter with an error is a crashed message. If it belonged to a Citizen, it becomes a
// `crash` event, stamped with the tick the message was about (not the tick Runner is on when the
// letter arrives, which depends on timing). Anything else (a message discarded because its actor
// stopped, or one that is not a Citizen's) is not a crash and is ignored.
export function crashEventOf(letter: DeadLetter, agentOf: (actorId: string) => AgentId | undefined): LedgerEvent | undefined {
    if (letter.error === undefined) return undefined;
    const agent = agentOf(letter.childId);
    if (agent === undefined) return undefined;
    const message = letter.message as CitizenMsg;
    const tick = message.type === "tick" ? message.observation.tick
        : message.type === "outcome" ? message.outcome.tick
        : message.type === "hear" ? (message.messages[0]?.tick ?? -1)
        : message.tick;
    return { tick, kind: "crash", agent, reason: `${message.type} handler: ${reasonOf(letter.error)}` };
}

const byTickThenAgent = (a: LedgerEvent, b: LedgerEvent): number =>
    a.tick - b.tick || ("agent" in a && "agent" in b ? (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : 0) : 0);

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
