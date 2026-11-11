// citizen.ts — see STEPS.md, step 2 (pipe-to-self — step 3).
//
// The agent actor. On `tick` it starts the policy and returns at once; the policy's outcome
// comes back as a `policyResults` or `policyFailed` message (pipeTo), and only then does the
// Citizen send its one `submit` for that tick. So a slow (LLM) policy never blocks the mailbox.
//
// Memory: one record per tick, kept for the last `memoryTicks` ticks (older ones are forgotten
// for now; longer runs will summarize them). `tick` opens a record with what the agent saw and
// the private messages it read; `policyResults` / `policyFailed` add what it chose or why its turn
// was empty; `outcome` (from the World, via Runner) adds what came of it.
//
// Inbox: `hear` (messages said to it last tick, via Runner) fills it, and the next `tick` hands it
// to the policy and empties it, so each message is shown once. Runner sends a tick's messages and
// outcomes before it starts the next tick, and one mailbox is FIFO, so the next tick sees both.
//
// At most one policy call is in flight: a new tick aborts the previous one if it is still
// thinking, so a slow model cannot pile up calls nobody will use.

import { z } from "zod";
import { pipeTo, type ServerRef, type Supervisor } from "@cue/core";
import { PolicyOutput, type Action, type AgentId, type Memory, type Message, type Observation, type Outcome, type Policy, type Say, type TickMemory, type SubmitTarget, type Tick, type WorldAction } from "../contracts";

export type CitizenMsg =
    | { type: "tick"; observation: Observation; replyTo: SubmitTarget }
    | { type: "outcome"; outcome: Outcome }
    | { type: "hear"; messages: Message[] }
    | { type: "policyResults"; tick: Tick; results: Action[]; replyTo: SubmitTarget }
    | { type: "policyFailed"; tick: Tick; reason: string; replyTo: SubmitTarget };

export type CitizenRef = ServerRef<CitizenMsg>;

export interface CitizenOptions {
    // Aborts when the citizen dies or the run ends; every policy call's signal follows it.
    lifetime?: AbortSignal;
    // How many ticks of its own history the agent remembers (the current one included).
    memoryTicks?: number;
}

export const DEFAULT_MEMORY_TICKS = 20;

interface CitizenState {
    id: AgentId;
    tick: Tick; // the latest tick it started deciding on; -1 before the first
    inbox: Message[]; // filled by `hear` between ticks; read, then emptied, by the next `tick`
    memory: Memory; // the agent's own history: a record per tick, filled in by tick, policy results and outcome
    thinking?: AbortController; // the policy call for `tick`, until it settles
}

const LOCAL_ACTIONS: ReadonlySet<Action["type"]> = new Set(["say", "revise_values"]);
const isWorldAction = (action: Action): action is WorldAction => !LOCAL_ACTIONS.has(action.type);

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export function spawnCitizen(system: Supervisor, id: AgentId, policy: Policy, options: CitizenOptions = {}): CitizenRef {
    const { lifetime, memoryTicks = DEFAULT_MEMORY_TICKS } = options;
    const self = system.spawnServer<CitizenState, CitizenMsg>({
        initialState: { id, tick: -1, inbox: [], memory: { ticks: [] } },
        handlers: {
            tick: (state, { observation, replyTo }) => {
                const { tick } = observation;
                // A duplicate or out-of-order tick changes nothing, so the current turn keeps its submit.
                if (tick <= state.tick) return state;

                // Still thinking about the previous tick: that turn is lost, and its record says so.
                let past = state.memory.ticks;
                if (state.thinking) {
                    state.thinking.abort(new Error(`superseded by tick ${tick}`));
                    past = withRecord(past, state.tick, { failure: "no answer before the next tick" });
                }
                const thinking = new AbortController();
                const signal = lifetime ? AbortSignal.any([lifetime, thinking.signal]) : thinking.signal;

                // The policy gets copies, never the actor's own arrays: the inbox, and the history
                // before this tick.
                const inbox = [...state.inbox];
                const memory: Memory = { ticks: past.map(record => ({ ...record })) };
                const record: TickMemory = {
                    tick,
                    estimatedP: observation.estimatedP,
                    balance: observation.self.balance,
                    privateMessages: inbox.filter(m => m.to !== "all"),
                };
                pipeTo(self)(
                    () => policy(observation, inbox, memory, signal),
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
                return { ...state, tick, thinking, inbox: [], memory: { ticks: [...past, record].slice(-memoryTicks) } };
            },

            // Only stored: the policy reads them on the next tick.
            hear: (state, { messages }) => ({ ...state, inbox: [...state.inbox, ...messages] }),

            // Only stored: the policy reads it on the next tick. A handler never calls a model.
            outcome: (state, { outcome }) => ({
                ...state,
                memory: { ticks: withRecord(state.memory.ticks, outcome.tick, { outcome }) },
            }),

            // A result for an older tick is late: Runner has already moved on, so it is dropped.
            policyResults: (state, { tick, results, replyTo }) => {
                if (tick !== state.tick) return state;
                // `say` travels with the turn and Runner routes it; `revise_values` is not handled yet.
                const messages = results.filter((action): action is Say => action.type === "say");
                replyTo.cast({
                    type: "submit", from: state.id, tick, actions: results.filter(isWorldAction),
                    ...(messages.length > 0 ? { messages } : {}),
                });
                return { ...state, thinking: undefined, memory: { ticks: withRecord(state.memory.ticks, tick, { actions: results }) } };
            },

            policyFailed: (state, { tick, reason, replyTo }) => {
                if (tick !== state.tick) return state;
                replyTo.cast({ type: "submit", from: state.id, tick, actions: [], error: reason });
                return { ...state, thinking: undefined, memory: { ticks: withRecord(state.memory.ticks, tick, { failure: reason }) } };
            },
        },
    });
    return self;
}

// The history with the record for `tick` updated. A tick no longer remembered is left alone.
function withRecord(ticks: TickMemory[], tick: Tick, patch: Partial<TickMemory>): TickMemory[] {
    return ticks.map(record => (record.tick === tick ? { ...record, ...patch } : record));
}

const oneLine = (error: z.ZodError): string => z.prettifyError(error).replace(/\s*\n\s*/g, "; ");
