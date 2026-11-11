// openaiCompatible.ts — see STEPS.md, step 3.
//
// A Provider for any server that speaks the OpenAI chat completions format:
// POST {baseUrl}/chat/completions. DeepSeek, OpenRouter, OpenAI, Ollama and LM Studio all do.
// Plain fetch, no SDK. Nothing in here knows about a particular vendor: vendor-specific request
// fields (DeepSeek's `thinking`, for example) come in through `extraBody`.

import { z } from "zod";
import type { LLMRequest, LLMResponse, Provider } from "./provider";

export interface OpenAICompatibleConfig {
    baseUrl: string; // without a trailing /chat/completions, e.g. "https://api.deepseek.com"
    model: string;
    apiKey?: string; // sent as `Authorization: Bearer …` when set; never read from the environment here
    extraBody?: Record<string, unknown>; // merged into every request body, e.g. { thinking: { type: "disabled" } }
    fetch?: typeof globalThis.fetch; // injectable, so tests run without a network
}

// The part of the server's answer we use. The body is untrusted JSON from the network, so it is
// checked like any other input; unknown fields are ignored.
const ChatCompletion = z.object({
    model: z.string(),
    choices: z.array(z.object({
        message: z.object({ content: z.string().nullable() }),
        finish_reason: z.string().nullable(),
    })).min(1),
    usage: z.object({
        prompt_tokens: z.number(),
        completion_tokens: z.number(),
        prompt_cache_hit_tokens: z.number().optional(), // DeepSeek
        prompt_tokens_details: z.object({ cached_tokens: z.number().optional() }).nullish(), // OpenAI's name for the same
    }).optional(),
});
type ChatCompletion = z.infer<typeof ChatCompletion>;

// How much of an error body goes into the error message: enough to see what went wrong, not a
// whole HTML error page.
const ERROR_BODY_CHARS = 200;

export class OpenAICompatibleProvider implements Provider {
    private readonly fetch: typeof globalThis.fetch;

    constructor(private readonly config: OpenAICompatibleConfig) {
        this.fetch = config.fetch ?? globalThis.fetch;
    }

    async complete(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        // No key, no header: an empty or placeholder Authorization is still a credential to the server.
        if (this.config.apiKey) headers["Authorization"] = `Bearer ${this.config.apiKey}`;

        // this.fetch, not the global one: tests inject a fake. An aborted signal rejects with its reason.
        const response = await this.fetch(`${this.config.baseUrl}/chat/completions`, {
            method: "POST",
            headers,
            body: JSON.stringify(toRequestBody(this.config, request)),
            signal,
        });

        // Read as text first: an error page or a broken body is often not JSON, and its text is
        // what says what went wrong.
        const body = await response.text();
        if (!response.ok) {
            throw new Error(`${this.config.baseUrl} answered ${response.status} ${response.statusText}: ${body.slice(0, ERROR_BODY_CHARS)}`);
        }

        let json: unknown;
        try {
            json = JSON.parse(body);
        } catch {
            throw new Error(`${this.config.baseUrl} answered with a body that is not JSON: ${body.slice(0, ERROR_BODY_CHARS)}`);
        }

        const parsed = ChatCompletion.safeParse(json);
        if (!parsed.success) {
            throw new Error(`${this.config.baseUrl} answered with an unexpected body: ${z.prettifyError(parsed.error)}`);
        }
        return toResponse(parsed.data);
    }
}

// Our request → the wire format.
// - The system prompt becomes the first message, role "system"; our messages follow unchanged.
// - maxTokens → max_tokens; temperature only when it is set.
// - extraBody is merged last. `schema` is ignored for now (see STEPS.md: structured output later).
export function toRequestBody(config: OpenAICompatibleConfig, request: LLMRequest): Record<string, unknown> {
    return {
        model: config.model,
        messages: [{ role: "system", content: request.system}, ...request.messages],
        max_tokens: request.maxTokens,
        temperature: request.temperature, // undefined is left out by JSON.stringify
        ...config.extraBody, // vendor fields (DeepSeek's thinking switch) come from the caller, never from here
    };
}

// The wire format → our response.
// - text: the first choice's content; null becomes "" (it then counts as an unreadable answer).
// - stopReason: from finish_reason, see stopReasonOf.
// - usage: prompt_tokens / completion_tokens → inputTokens / outputTokens; 0 when missing.
//   Cache hits → cachedInputTokens, only when the server reports them.
// - model: what the server says it ran, not what was asked for.
export function toResponse(completion: ChatCompletion): LLMResponse {
    const [choice] = completion.choices; // the schema guarantees at least one
    const { usage } = completion;
    const cached = usage?.prompt_cache_hit_tokens ?? usage?.prompt_tokens_details?.cached_tokens;
    return {
        text: choice?.message.content ?? "",
        usage: {
            inputTokens: usage?.prompt_tokens ?? 0,
            outputTokens: usage?.completion_tokens ?? 0,
            ...(cached === undefined ? {} : { cachedInputTokens: cached }),
        },
        stopReason: stopReasonOf(choice?.finish_reason ?? null),
        model: completion.model,
    };
}

// "stop" → "end", "length" → "maxTokens", anything else (null, "content_filter", …) → "other".
export function stopReasonOf(finishReason: string | null): LLMResponse["stopReason"] {
    switch (finishReason) {
        case "stop": return "end";
        case "length": return "maxTokens";
        default: return "other";
    }
}
