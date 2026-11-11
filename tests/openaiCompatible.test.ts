// The adapter against a fake fetch: what it sends, and how it reads what comes back.
// The real server is checked by hand (scripts/ping.ts), not here.

import { describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider, stopReasonOf, type OpenAICompatibleConfig } from "../src/llm/openaiCompatible";
import type { LLMRequest } from "../src/llm/provider";

const request: LLMRequest = {
    system: "rules",
    messages: [{ role: "user", content: "Tick 0." }],
    maxTokens: 500,
};

// A server's successful answer, with fields overridable per test.
const completion = (overrides: Record<string, unknown> = {}) => ({
    id: "x",
    model: "deepseek-flash-served",
    choices: [{ index: 0, message: { role: "assistant", content: '{"actions":[]}' }, finish_reason: "stop" }],
    usage: { prompt_tokens: 870, completion_tokens: 19, total_tokens: 889, prompt_cache_hit_tokens: 832 },
    ...overrides,
});

// A fake fetch that answers with `body` (JSON unless it is a string) and records each call.
function fakeFetch(body: unknown, status = 200) {
    return vi.fn<typeof fetch>(async () =>
        new Response(typeof body === "string" ? body : JSON.stringify(body), { status }));
}

function provider(fetch: typeof globalThis.fetch, config: Partial<OpenAICompatibleConfig> = {}) {
    return new OpenAICompatibleProvider({ baseUrl: "https://api.example.com", model: "deepseek-flash", fetch, ...config });
}

// What the fake fetch was called with: the URL, the parsed body and the init.
function sent(fetch: ReturnType<typeof fakeFetch>) {
    const [url, init] = fetch.mock.calls[0]!;
    return { url: String(url), body: JSON.parse(String(init?.body)), init: init! };
}

describe("OpenAICompatibleProvider: the request", () => {
    it("posts to {baseUrl}/chat/completions as JSON", async () => {
        const fetch = fakeFetch(completion());
        await provider(fetch).complete(request);

        const { url, init } = sent(fetch);
        expect(url).toBe("https://api.example.com/chat/completions");
        expect(init.method).toBe("POST");
        expect(new Headers(init.headers).get("content-type")).toBe("application/json");
    });

    it("puts the system prompt first, then our messages, with the model and max_tokens", async () => {
        const fetch = fakeFetch(completion());
        await provider(fetch).complete(request);

        expect(sent(fetch).body).toEqual({
            model: "deepseek-flash",
            messages: [{ role: "system", content: "rules" }, { role: "user", content: "Tick 0." }],
            max_tokens: 500,
        });
    });

    it("sends temperature only when it is set", async () => {
        const fetch = fakeFetch(completion());
        await provider(fetch).complete({ ...request, temperature: 0.7 });

        expect(sent(fetch).body.temperature).toBe(0.7);
    });

    it("merges extraBody into the request (vendor fields like DeepSeek's thinking switch)", async () => {
        const fetch = fakeFetch(completion());
        await provider(fetch, { extraBody: { thinking: { type: "disabled" } } }).complete(request);

        expect(sent(fetch).body.thinking).toEqual({ type: "disabled" });
    });

    it("sends the key as a bearer token, and no Authorization header without one", async () => {
        const withKey = fakeFetch(completion());
        await provider(withKey, { apiKey: "sk-test" }).complete(request);
        expect(new Headers(sent(withKey).init.headers).get("authorization")).toBe("Bearer sk-test");

        const withoutKey = fakeFetch(completion());
        await provider(withoutKey).complete(request);
        expect(new Headers(sent(withoutKey).init.headers).has("authorization")).toBe(false);
    });

    it("passes the signal to fetch, so an aborted turn stops the request", async () => {
        const fetch = fakeFetch(completion());
        const controller = new AbortController();
        await provider(fetch).complete(request, controller.signal);

        expect(sent(fetch).init.signal).toBe(controller.signal);
    });
});

describe("OpenAICompatibleProvider: the response", () => {
    it("reads text, usage, stop reason, and the model the server says it ran", async () => {
        const response = await provider(fakeFetch(completion())).complete(request);

        expect(response).toEqual({
            text: '{"actions":[]}',
            usage: { inputTokens: 870, outputTokens: 19, cachedInputTokens: 832 },
            stopReason: "end",
            model: "deepseek-flash-served",
        });
    });

    it("an answer cut off at max_tokens reports maxTokens", async () => {
        const body = completion({ choices: [{ message: { content: '{"act' }, finish_reason: "length" }] });
        expect((await provider(fakeFetch(body)).complete(request)).stopReason).toBe("maxTokens");
    });

    it("null content becomes an empty text", async () => {
        const body = completion({ choices: [{ message: { content: null }, finish_reason: "stop" }] });
        expect((await provider(fakeFetch(body)).complete(request)).text).toBe("");
    });

    it("reads OpenAI's name for cache hits too, and leaves the field out when the server says nothing", async () => {
        const openai = completion({ usage: { prompt_tokens: 900, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 768 } } });
        expect((await provider(fakeFetch(openai)).complete(request)).usage).toEqual({ inputTokens: 900, outputTokens: 5, cachedInputTokens: 768 });

        const silent = completion({ usage: { prompt_tokens: 900, completion_tokens: 5 } });
        expect((await provider(fakeFetch(silent)).complete(request)).usage).not.toHaveProperty("cachedInputTokens");
    });

    it("missing usage counts as 0 tokens", async () => {
        const { usage: _, ...body } = completion();
        expect((await provider(fakeFetch(body)).complete(request)).usage).toEqual({ inputTokens: 0, outputTokens: 0 });
    });
});

describe("OpenAICompatibleProvider: failures", () => {
    it("an error status rejects with the status and the start of the body", async () => {
        const fetch = fakeFetch('{"error":{"message":"Authentication Fails"}}', 401);
        await expect(provider(fetch).complete(request)).rejects.toThrow(/401.*Authentication Fails/);
    });

    it("a huge error page is cut short in the message", async () => {
        const page = "<html>" + "x".repeat(50_000) + "</html>";
        const error = await provider(fakeFetch(page, 502)).complete(request).catch((e: Error) => e);

        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toContain("502");
        expect((error as Error).message.length).toBeLessThan(400);
    });

    it("a body that is not a chat completion rejects", async () => {
        await expect(provider(fakeFetch({ choices: [] })).complete(request)).rejects.toThrow();
        await expect(provider(fakeFetch("not json")).complete(request)).rejects.toThrow();
    });

    it("an abort rejects with the abort reason", async () => {
        const controller = new AbortController();
        controller.abort("superseded by tick 3");
        // Like the real fetch: an aborted signal rejects with its reason.
        const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => { init?.signal?.throwIfAborted(); return new Response("{}"); });

        await expect(provider(fetch).complete(request, controller.signal)).rejects.toBe("superseded by tick 3");
    });
});

describe("stopReasonOf", () => {
    it.each([
        ["stop", "end"],
        ["length", "maxTokens"],
        ["content_filter", "other"],
        [null, "other"],
    ] as const)("%s → %s", (finishReason, stopReason) => {
        expect(stopReasonOf(finishReason)).toBe(stopReason);
    });
});
