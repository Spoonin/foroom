// citizen.ts — see STEPS.md, step 2 (pipe-to-self — step 3).
//
// The agent actor. On `tick` it starts the policy and returns at once; the policy's outcome
// comes back as a `policyResults` or `policyFailed` message (pipeTo), and only then does the
// Citizen send its one `submit` for that tick. So a slow (LLM) policy never blocks the mailbox.
//
// At most one policy call is in flight: a new tick aborts the previous one if it is still
// thinking, so a slow model cannot pile up calls nobody will use.

import { z } from "zod";
import { pipeTo, type ServerRef, type Supervisor } from "@cue/core";
import { PolicyOutput, type Action, type AgentId, type Message, type Observation, type Policy, type SubmitTarget, type Tick, type WorldAction } from "../contracts";

export type CitizenMsg =
    | { type: "tick"; observation: Observation; replyTo: SubmitTarget }
    | { type: "policyResults"; tick: Tick; results: Action[]; replyTo: SubmitTarget }
    | { type: "policyFailed"; tick: Tick; reason: string; replyTo: SubmitTarget };

export type CitizenRef = ServerRef<CitizenMsg>;

export interface CitizenOptions {
    // Aborts when the citizen dies or the run ends; every policy call's signal follows it.
    lifetime?: AbortSignal;
}

interface CitizenState {
    id: AgentId;
    tick: Tick; // the latest tick it started deciding on; -1 before the first
    inbox: Message[]; // filled by `hear` in step 4
    thinking?: AbortController; // the policy call for `tick`, until it settles
}

const LOCAL_ACTIONS: ReadonlySet<Action["type"]> = new Set(["say", "revise_values"]);
const isWorldAction = (action: Action): action is WorldAction => !LOCAL_ACTIONS.has(action.type);

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function spawnCitizen(system: Supervisor, id: AgentId, policy: Policy, options: CitizenOptions = {}): CitizenRef {
    const { lifetime } = options;
    const self = system.spawnServer<CitizenState, CitizenMsg>({
        initialState: { id, tick: -1, inbox: [] },
        handlers: {
            tick: (state, { observation, replyTo }) => {
                const { tick } = observation;
                // A duplicate or out-of-order tick changes nothing, so the current turn keeps its submit.
                if (tick <= state.tick) return state;

                state.thinking?.abort(new Error(`superseded by tick ${tick}`)); // a no-op if it already settled
                const thinking = new AbortController();
                const signal = lifetime ? AbortSignal.any([lifetime, thinking.signal]) : thinking.signal;

                const inbox = [...state.inbox]; // the policy gets a copy, never the actor's own array
                pipeTo(self)(
                    () => policy(observation, inbox, signal),
                    (results) => {
                        // Checked here, so a bad value becomes a failed turn with a reason instead
                        // of crashing a handler later (which would only show up as a timeout).
                        const parsed = PolicyOutput.safeParse(results);
                        return parsed.success
                            ? { type: "policyResults", tick, results: parsed.data, replyTo }
                            : { type: "policyFailed", tick, reason: `invalid policy output: ${oneLine(parsed.error)}`, replyTo };
                    },
                    (error) => ({ type: "policyFailed", tick, reason: reasonOf(error), replyTo }),
                );
                return { ...state, tick, thinking };
            },

            // A result for an older tick is late: Runner has already moved on, so it is dropped.
            policyResults: (state, { tick, results, replyTo }) => {
                if (tick !== state.tick) return state;
                // Local actions (say, revise_values) get handled here in steps 3–4; for now they are ignored.
                replyTo.cast({ type: "submit", from: state.id, tick, actions: results.filter(isWorldAction) });
                return { ...state, thinking: undefined };
            },

            policyFailed: (state, { tick, reason, replyTo }) => {
                if (tick !== state.tick) return state;
                replyTo.cast({ type: "submit", from: state.id, tick, actions: [], error: reason });
                return { ...state, thinking: undefined };
            },
        },
    });
    return self;
}

const oneLine = (error: z.ZodError): string => z.prettifyError(error).replace(/\s*\n\s*/g, "; ");
