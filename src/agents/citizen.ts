// citizen.ts — see STEPS.md, step 2 (pipe-to-self — step 3).
//
// The agent actor. On `tick` it starts the policy and returns at once; the policy's outcome
// comes back as a `policyResults` or `policyFailed` message (pipeTo), and only then does the
// Citizen send its one `submit` for that tick. So a slow (LLM) policy never blocks the mailbox.

import { pipeTo, type ServerRef, type Supervisor } from "@cue/core";
import type { Action, AgentId, Message, Observation, Policy, SubmitTarget, Tick, WorldAction } from "../contracts";

export type CitizenMsg =
    | { type: "tick"; observation: Observation; replyTo: SubmitTarget }
    | { type: "policyResults"; tick: Tick; results: Action[]; replyTo: SubmitTarget }
    | { type: "policyFailed"; tick: Tick; reason: string; replyTo: SubmitTarget };

export type CitizenRef = ServerRef<CitizenMsg>;

interface CitizenState {
    id: AgentId;
    tick: Tick; // the latest tick it started deciding on; -1 before the first
    inbox: Message[]; // filled by `hear` in step 4
}

const LOCAL_ACTIONS: ReadonlySet<Action["type"]> = new Set(["say", "revise_values"]);
const isWorldAction = (action: Action): action is WorldAction => !LOCAL_ACTIONS.has(action.type);

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function spawnCitizen(system: Supervisor, id: AgentId, policy: Policy): CitizenRef {
    const self = system.spawnServer<CitizenState, CitizenMsg>({
        initialState: { id, tick: -1, inbox: [] },
        handlers: {
            tick: (state, { observation, replyTo }) => {
                const { tick } = observation;
                // A duplicate or out-of-order tick changes nothing, so the current turn keeps its submit.
                if (tick <= state.tick) return state;

                const inbox = [...state.inbox]; // the policy gets a copy, never the actor's own array
                pipeTo(self)(
                    () => policy(observation, inbox),
                    (results) => ({ type: "policyResults", tick, results, replyTo }),
                    (error) => ({ type: "policyFailed", tick, reason: reasonOf(error), replyTo }),
                );
                return { ...state, tick };
            },

            // A result for an older tick is late: Runner has already moved on, so it is dropped.
            policyResults: (state, { tick, results, replyTo }) => {
                if (tick !== state.tick) return state;
                // Local actions (say, revise_values) get handled here in steps 3–4; for now they are ignored.
                replyTo.cast({ type: "submit", from: state.id, tick, actions: results.filter(isWorldAction) });
                return state;
            },

            policyFailed: (state, { tick, reason, replyTo }) => {
                if (tick !== state.tick) return state;
                replyTo.cast({ type: "submit", from: state.id, tick, actions: [], error: reason });
                return state;
            },
        },
    });
    return self;
}
