import type { ServerRef, Supervisor } from "@cue/core";
import { pipeTo } from "@cue/core";
import type { AgentId, Message, Observation, Policy, RunnerMsg, Tick, WorldAction } from "../contracts";


type CitizenMsg =
| {type: "tick", tick: Tick, observation: Observation, replyTo: ServerRef<RunnerMsg>}
| {type: "policyResults", results: WorldAction[], replyTo: ServerRef<RunnerMsg>, tick: Tick}
| { type: "policyFailed"; reason: string, replyTo: ServerRef<RunnerMsg>, tick: Tick}

interface CitizenState{
    tick: Tick,
    inbox: Message[],
    id: AgentId
}

export function spawnCitizen(system: Supervisor, id: AgentId, policy: Policy, tick: Tick): ServerRef<CitizenMsg>{
    const self = system.spawnServer<CitizenState, CitizenMsg>({
        initialState:{ tick, id, inbox: [] },
        handlers: {
            tick: (state, msg) => {
                const {tick, observation, replyTo} = msg;
                if(tick !== observation.tick || state.tick >= observation.tick){
                    return state;
                }

                pipeTo(self)(
                    () => policy(observation, state.inbox), 
                    (results) => ({type: "policyResults", results, replyTo, tick}),
                    (error) => ({ type: "policyFailed", replyTo, tick, reason: error instanceof Error ? error.message : String(error)})
                )

                return {...state, tick};
            },
            "policyResults": (state, {results, replyTo, tick}) => {
                if(tick === state.tick){
                    replyTo.cast({ type: "submit", actions: results, tick, from: state.id });
                }
                return state;
            },
            "policyFailed": (state, {reason, replyTo, tick}) => {
                console.error(reason);
                if(tick === state.tick){
                    replyTo.cast({ type: "submit", actions: [], tick, from: state.id });
                }
                return state;
            }
        }
    });
    return self;
}