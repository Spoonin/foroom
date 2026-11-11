import { afterEach, describe, expect, it, vi } from "vitest";
import { laws } from "../src/config";
import type { Laws, Memory, Message, Observation } from "../src/contracts";
import { makeLLMPolicy, type ResponseLog } from "../src/agents/llm/llmPolicy";
import { buildPrompt, buildSituation } from "../src/agents/llm/prompt";
import { MockProvider, type Provider } from "../src/llm/provider";
import { runSimulation } from "../src/world/runner";
import { ofKind } from "../src/world/ledger";

const obs = (tick = 5, id = "agent-02"): Observation => ({
    tick,
    self: { id, age: tick, balance: 740, hungerTicks: 0 },
    citizenCount: 3,
    residents: ["agent-01", "agent-02", "agent-03"],
    estimatedP: 41_234,
    laws: structuredClone(laws) as Laws,
});

const inbox: Message[] = [{ tick: 4, from: "agent-01", to: "all", text: "hello" }];

// A policy over a mock, with every ResponseLog collected.
function setup(provider: Provider, maxTokens = 500) {
    const logs: ResponseLog[] = [];
    const policy = makeLLMPolicy(provider, { maxTokens, temperature: 0.7, onResponse: log => logs.push(log) });
    return { policy, logs };
}

afterEach(() => { vi.useRealTimers(); });

describe("makeLLMPolicy: the request", () => {
    it("sends the prompt for this observation and inbox, with maxTokens and temperature", async () => {
        const provider = new MockProvider(['{"actions":[]}']);
        const { policy } = setup(provider, 321);
        const observation = obs();

        await policy(observation, inbox);

        expect(provider.requests).toEqual([{ ...buildPrompt(observation, inbox), maxTokens: 321, temperature: 0.7 }]);
    });

    it("puts the agent's memory into the prompt", async () => {
        const provider = new MockProvider(['{"actions":[]}']);
        const { policy } = setup(provider);
        const observation = obs(5);
        const memory: Memory = { outcomes: [{ tick: 4, giftsReceived: [{ from: "agent-01", amount: 50 }], giftsSent: [], ignored: [], upkeep: { paid: 100, due: 100 } }] };

        await policy(observation, inbox, memory);

        expect(provider.requests[0]?.messages).toEqual(buildPrompt(observation, inbox, memory).messages);
        expect(provider.requests[0]?.messages[0]?.content).toContain("agent-01 gave you 50 credits.");
    });

    it("passes the signal on: an abort while the model thinks rejects with the abort reason", async () => {
        vi.useFakeTimers();
        const { policy, logs } = setup(new MockProvider(['{"actions":[]}'], { delayMs: 1_000 }));
        const thinking = new AbortController();

        const answer = policy(obs(), [], undefined, thinking.signal);
        const check = expect(answer).rejects.toBe("superseded by tick 6");
        await vi.advanceTimersByTimeAsync(100);
        thinking.abort("superseded by tick 6");
        await check;

        expect(logs).toEqual([]); // no response arrived, so nothing to report
    });
});

describe("makeLLMPolicy: the answer", () => {
    it("returns the actions of a valid answer, local ones included, and reports the call", async () => {
        const text = '```json\n{"actions":[{"type":"harvest","amount":300},{"type":"say","to":"all","text":"hi"}]}\n```';
        const { policy, logs } = setup(new MockProvider([text]));

        await expect(policy(obs(5, "agent-02"), [])).resolves.toEqual([
            { type: "harvest", amount: 300 },
            { type: "say", to: "all", text: "hi" },
        ]);
        expect(logs).toEqual([{
            agentId: "agent-02",
            tick: 5,
            response: expect.objectContaining({ text, stopReason: "end", model: "Mock model" }),
            rejected: [],
            error: undefined,
            situation: buildSituation(obs(5, "agent-02"), []),
        }]);
    });

    it("keeps the valid actions of a mixed answer and reports the rejected ones", async () => {
        const text = '{"actions":[{"type":"harvest","amount":300},{"type":"gift","to":"agent-01","amount":-5}]}';
        const { policy, logs } = setup(new MockProvider([text]));

        await expect(policy(obs(), [])).resolves.toEqual([{ type: "harvest", amount: 300 }]);
        expect(logs[0]?.rejected).toEqual([
            { index: 1, value: { type: "gift", to: "agent-01", amount: -5 }, error: expect.stringContaining("amount") },
        ]);
        expect(logs[0]?.error).toBeUndefined();
    });

    it("rejects an unreadable answer with the parser's reason, and reports it", async () => {
        const { policy, logs } = setup(new MockProvider(["I will harvest 300 this turn."]));

        const failure = await Promise.resolve(policy(obs(), [])).then(() => undefined, (error: unknown) => error);

        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(logs[0]?.error);
        expect(logs).toHaveLength(1);
        expect(logs[0]?.error).toEqual(expect.any(String));
        expect(logs[0]?.rejected).toEqual([]);
    });

    it("blames maxTokens, not the model, when a cut-off answer is unreadable", async () => {
        const cutOff = { text: '{"actions":[{"type":"harv', stopReason: "maxTokens" as const };
        const { policy, logs } = setup(new MockProvider([cutOff]), 64);

        await expect(policy(obs(), [])).rejects.toThrow(/max.?tokens.*64/i);
        expect(logs[0]?.error).toMatch(/max.?tokens.*64/i);
    });

    it("a readable answer that hit maxTokens is still a valid turn", async () => {
        const { policy } = setup(new MockProvider([{ text: '{"actions":[]}', stopReason: "maxTokens" }]));

        await expect(policy(obs(), [])).resolves.toEqual([]);
    });

    it("lets a provider error through unchanged, and reports nothing", async () => {
        const down = new Error("503 Service Unavailable");
        const provider: Provider = { complete: () => Promise.reject(down) };
        const { policy, logs } = setup(provider);

        await expect(policy(obs(), [])).rejects.toBe(down);
        expect(logs).toEqual([]);
    });
});

describe("makeLLMPolicy inside a run", () => {
    const ids = ["agent-01", "agent-02", "agent-03", "agent-04", "agent-05"];

    it("5 agents that each think for 200 ms finish a tick in about 200 ms, not 1000: the calls run in parallel", async () => {
        const provider = new MockProvider(() => '{"actions":[{"type":"harvest","amount":100}]}', { delayMs: 200 });
        const policy = makeLLMPolicy(provider, { maxTokens: 500 });

        const started = performance.now();
        const { ticksRun } = await runSimulation({ seed: 1, ticks: 1, citizens: ids.map(id => ({ id, policy })) });
        const elapsed = performance.now() - started;

        expect(ticksRun).toBe(1);
        expect(provider.requests).toHaveLength(5);
        expect(elapsed).toBeLessThan(600);
    });

    it("an unreadable answer reaches the ledger as a policy failure with its reason", async () => {
        const provider = new MockProvider(req =>
            req.messages[0]?.content.includes("You are agent-01.") ? "no json here" : '{"actions":[]}');
        const policy = makeLLMPolicy(provider, { maxTokens: 500 });

        const { events } = await runSimulation({ seed: 1, ticks: 1, citizens: ids.map(id => ({ id, policy })) });

        expect(ofKind(events, "policyFailed")).toEqual([
            expect.objectContaining({ agent: "agent-01", reason: expect.stringContaining("JSON") }),
        ]);
    });
});
