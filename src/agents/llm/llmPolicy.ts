import type { AgentId, Policy, Tick } from "../../contracts";
import type { Provider, LLMResponse } from "../../llm/provider";
import { parseActions, type Rejection } from "./parse";
import { buildPrompt } from "./prompt";

export interface ResponseLog{
    response: LLMResponse;
    tick: Tick;
    agentId: AgentId;
    rejected: Rejection[];
    error?: string;
    situation: string;
}
export function makeLLMPolicy(provider: Provider, options: {temperature?: number; maxTokens: number; onResponse?:(log:ResponseLog) => void}):Policy {
    return (observation, inbox, memory, signal) => {
        const prompt = buildPrompt(observation, inbox, memory);
        return provider.complete({ 
            maxTokens: options.maxTokens,
            temperature: options.temperature,
            ...prompt
        }, signal).then((response) => {
            const parsed = parseActions(response.text);
            
            let errorMessage;

            if(parsed.kind === "unreadable"){
                if(response.stopReason === "maxTokens"){
                    errorMessage = `Response crossed max tokens limit:${options.maxTokens}`;
                } else {
                    errorMessage = parsed.error;
                }
            }

            options.onResponse?.({
                response,
                tick: observation.tick,
                agentId: observation.self.id,
                rejected: parsed.kind === "read" ? parsed.rejected : [],
                error: errorMessage,
                situation: prompt.messages[0]?.content ?? "",
            });

            if(parsed.kind === "unreadable"){
                throw new Error(errorMessage);
            }

            return parsed.actions;
        });
    }
}
