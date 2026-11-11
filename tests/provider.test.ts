import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockProvider, type LLMRequest } from "../src/llm/provider";

const request = (content = "tick 0"): LLMRequest => ({
    system: "rules",
    messages: [{ role: "user", content }],
    maxTokens: 100,
});

// Whether a promise has settled, without awaiting it.
function track<T>(promise: Promise<T>) {
    const state = { settled: false };
    promise.then(() => { state.settled = true; }, () => { state.settled = true; });
    return state;
}

describe("MockProvider: answers", () => {
    it("returns the answers in order and records each request", async () => {
        const provider = new MockProvider(["first", "second"]);

        expect((await provider.complete(request("a"))).text).toBe("first");
        expect((await provider.complete(request("b"))).text).toBe("second");
        expect(provider.requests.map(r => r.messages[0]?.content)).toEqual(["a", "b"]);
    });

    it("rejects when the answers run out, instead of repeating the last one", async () => {
        const provider = new MockProvider(["only"]);
        await provider.complete(request());

        await expect(provider.complete(request())).rejects.toThrow();
    });

    it("passes the request to a function answer", async () => {
        const provider = new MockProvider(req => `echo: ${req.messages[0]?.content}`);

        expect((await provider.complete(request("tick 3"))).text).toBe("echo: tick 3");
    });

    it("reports a finished answer and usage that grows with the text", async () => {
        const provider = new MockProvider(["short", "a much, much longer answer than the first"]);
        const short = await provider.complete(request());
        const long = await provider.complete(request());

        expect(short.stopReason).toBe("end");
        expect(long.usage.outputTokens).toBeGreaterThan(short.usage.outputTokens);
        expect(short.usage.inputTokens).toBeGreaterThan(0);
    });
});

describe("MockProvider: delay and abort", () => {
    beforeEach(() => { vi.useFakeTimers(); });
    afterEach(() => { vi.useRealTimers(); });

    it("answers after the delay, not before", async () => {
        const provider = new MockProvider(["late"], { delayMs: 50 });
        const answer = provider.complete(request());
        const state = track(answer);

        await vi.advanceTimersByTimeAsync(49);
        expect(state.settled).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await expect(answer).resolves.toMatchObject({ text: "late" });
    });

    it("an abort during the delay rejects with the abort reason, and does not use up an answer", async () => {
        const provider = new MockProvider(["first", "second"], { delayMs: 50 });
        const controller = new AbortController();
        const superseded = provider.complete(request(), controller.signal);
        const check = expect(superseded).rejects.toBe("superseded by tick 1");

        await vi.advanceTimersByTimeAsync(10);
        controller.abort("superseded by tick 1");
        await check;

        // The next call still gets the first answer.
        const next = provider.complete(request());
        await vi.advanceTimersByTimeAsync(50);
        await expect(next).resolves.toMatchObject({ text: "first" });
    });

    it("an abort during the delay rejects at once, without waiting for the delay", async () => {
        const provider = new MockProvider(["x"], { delayMs: 1_000 });
        const controller = new AbortController();
        const answer = provider.complete(request(), controller.signal);
        const state = track(answer);
        answer.catch(() => {});

        controller.abort("agent died");
        await vi.advanceTimersByTimeAsync(0);
        expect(state.settled).toBe(true);
        expect(vi.getTimerCount()).toBe(0); // the delay timer was cleared
    });

    it("an already aborted signal rejects without waiting and without recording the request", async () => {
        const provider = new MockProvider(["x"], { delayMs: 1_000 });
        const signal = AbortSignal.abort("run stopped");

        await expect(provider.complete(request(), signal)).rejects.toBe("run stopped");
        expect(provider.requests).toEqual([]);
        expect(vi.getTimerCount()).toBe(0);
    });
});
