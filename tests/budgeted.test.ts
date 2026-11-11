import { afterEach, describe, expect, it, vi } from "vitest";
import { BudgetedProvider } from "../src/llm/budgeted";
import { MockProvider, type LLMRequest, type Provider } from "../src/llm/provider";
import { makeLLMPolicy } from "../src/agents/llm/llmPolicy";
import { runSimulation } from "../src/world/runner";
import { ofKind } from "../src/world/ledger";

const request: LLMRequest = { system: "s".repeat(30), messages: [{ role: "user", content: "u".repeat(30) }], maxTokens: 100 };

// A provider whose every answer costs exactly `input + output` tokens.
function fixedCost(input: number, output: number) {
    return vi.fn<Provider["complete"]>(async () => ({
        text: "{}", stopReason: "end" as const, model: "fixed", usage: { inputTokens: input, outputTokens: output },
    }));
}

function budgeted(complete: Provider["complete"], maxTokens: number) {
    const onExhausted = vi.fn<(spent: number) => void>();
    const provider = new BudgetedProvider({ complete }, { maxTokens, onExhausted });
    return { provider, onExhausted };
}

afterEach(() => { vi.useRealTimers(); });

describe("BudgetedProvider", () => {
    it("passes the request, the signal and the response through unchanged", async () => {
        const inner = new MockProvider(["answer"]);
        const provider = new BudgetedProvider(inner, { maxTokens: 1_000, onExhausted: () => {} });
        const signal = new AbortController().signal;
        const spy = vi.spyOn(inner, "complete");

        const response = await provider.complete(request, signal);

        expect(spy).toHaveBeenCalledWith(request, signal);
        expect(response).toMatchObject({ text: "answer", model: "Mock model" });
    });

    it("counts input and output tokens of every answer", async () => {
        const { provider } = budgeted(fixedCost(70, 30), 1_000);

        await provider.complete(request);
        await provider.complete(request);

        expect(provider.spent).toBe(200);
    });

    it("the answer that crosses the budget is still returned, and onExhausted fires once with the total", async () => {
        const { provider, onExhausted } = budgeted(fixedCost(70, 30), 250);

        await provider.complete(request); // 100
        await provider.complete(request); // 200
        const crossing = await provider.complete(request); // 300: over

        expect(crossing.text).toBe("{}");
        expect(onExhausted).toHaveBeenCalledTimes(1);
        expect(onExhausted).toHaveBeenCalledWith(300);
    });

    it("once exhausted, refuses every call at once, without calling the model", async () => {
        const inner = fixedCost(70, 30);
        const { provider, onExhausted } = budgeted(inner, 100);
        await provider.complete(request); // exactly the budget: exhausted

        await expect(provider.complete(request)).rejects.toThrow(/token budget exhausted: 100 of 100/);
        await expect(provider.complete(request)).rejects.toThrow(/token budget exhausted/);
        expect(inner).toHaveBeenCalledTimes(1);
        expect(onExhausted).toHaveBeenCalledTimes(1);
    });

    it("a failed call costs nothing, and its error passes through unchanged", async () => {
        const down = new Error("503");
        const { provider } = budgeted(vi.fn<Provider["complete"]>(async () => { throw down; }), 100);

        await expect(provider.complete(request)).rejects.toBe(down);
        expect(provider.spent).toBe(0);
    });

    it("an aborted call costs nothing, and rejects with the abort reason", async () => {
        vi.useFakeTimers();
        const provider = new BudgetedProvider(new MockProvider(["x"], { delayMs: 1_000 }), { maxTokens: 100, onExhausted: () => {} });
        const controller = new AbortController();

        const call = provider.complete(request, controller.signal);
        const check = expect(call).rejects.toBe("superseded by tick 2");
        controller.abort("superseded by tick 2");
        await check;
        expect(provider.spent).toBe(0);
    });

    it("calls in flight when the budget runs out still finish: the overshoot is bounded by what was in flight", async () => {
        vi.useFakeTimers();
        const { provider, onExhausted } = budgeted(async () => {
            await new Promise(resolve => setTimeout(resolve, 10));
            return { text: "{}", stopReason: "end" as const, model: "fixed", usage: { inputTokens: 70, outputTokens: 30 } };
        }, 150);

        const five = Promise.all(Array.from({ length: 5 }, () => provider.complete(request)));
        await vi.advanceTimersByTimeAsync(10);
        await five;

        expect(provider.spent).toBe(500); // all five started under budget; 350 over
        expect(onExhausted).toHaveBeenCalledTimes(1);
    });
});

describe("BudgetedProvider in a run", () => {
    it("stops the run through its AbortSignal once the budget is spent", async () => {
        const controller = new AbortController();
        const inner = new MockProvider(() => '{"actions":[{"type":"harvest","amount":100}]}');
        const provider = new BudgetedProvider(inner, {
            maxTokens: 1, // the very first answer exhausts it
            onExhausted: () => controller.abort(new Error("token budget exhausted")),
        });
        const policy = makeLLMPolicy(provider, { maxTokens: 100 });
        const citizens = ["a", "b", "c"].map(id => ({ id, policy }));

        const result = await runSimulation({ seed: 1, ticks: 50, citizens, signal: controller.signal });

        expect(result.endedBy).toBe("aborted");
        expect(result.ticksRun).toBeLessThanOrEqual(1);
        expect(String(controller.signal.reason)).toContain("token budget exhausted");
        expect(inner.requests.length).toBeLessThanOrEqual(2 * citizens.length);
        expect(ofKind(result.events, "pool").length).toBe(result.ticksRun);
    });
});
