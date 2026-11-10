// turnCollector.ts — see STEPS.md, step 2, "Tick protocol".
//
// Gathers the citizens' submits for one tick. A cue `call` reply is synchronous, so "reply when
// everyone has submitted" cannot be a call. Instead Runner opens a tick with an `onComplete`
// callback, races that against the turn deadline, and then closes the tick with a `call` that
// replies with whatever has arrived.
//
// One collector lives for the whole run and is never stopped between ticks, so a citizen's
// cast to it never hits a stopped actor. Rules:
//   - only the open tick counts: a submit for another tick is dropped (a late answer);
//   - only expected agents count: a submit from anyone else is dropped;
//   - the first submit from an agent counts, a duplicate is dropped;
//   - after `close`, nothing counts until the next `open`.

import type { ServerRef, Supervisor } from "@cue/core";
import type { AgentId, Submit, Tick } from "../contracts";

export type TurnCollectorMsg =
    | Submit
    | { type: "open"; tick: Tick; expected: readonly AgentId[]; onComplete: () => void }
    | { type: "close"; tick: Tick; reply: Map<AgentId, Submit> };

export type TurnCollectorRef = ServerRef<TurnCollectorMsg>;

interface TurnState {
    tick: Tick;
    open: boolean;
    expected: ReadonlySet<AgentId>;
    received: Map<AgentId, Submit>;
    onComplete: () => void;
}

const idle: TurnState = { tick: -1, open: false, expected: new Set(), received: new Map(), onComplete: () => {} };

export function spawnTurnCollector(system: Supervisor): TurnCollectorRef {
    return system.spawnServer<TurnState, TurnCollectorMsg>({
        initialState: idle,
        handlers: {
            open: (_state, { tick, expected, onComplete }) => {
                const next: TurnState = { tick, open: true, expected: new Set(expected), received: new Map(), onComplete };
                if (next.expected.size === 0) onComplete(); // nobody to wait for
                return next;
            },

            submit: (state, msg) => {
                if (!state.open || msg.tick !== state.tick) return state;
                if (!state.expected.has(msg.from) || state.received.has(msg.from)) return state;

                const received = new Map(state.received).set(msg.from, msg);
                if (received.size === state.expected.size) state.onComplete();
                return { ...state, received };
            },

            close: (state, { tick }) => {
                // Closing a tick that is not the open one is a Runner bug, not a late citizen.
                if (tick !== state.tick) throw new Error(`close(${tick}) while tick ${state.tick} is open`);
                return { state: { ...state, open: false }, reply: new Map(state.received) };
            },
        },
    });
}
