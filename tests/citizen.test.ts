import { afterEach, describe, expect, it, vi } from "vitest";
import { Supervisor } from "@cue/core";
import { spawnCitizen, type CitizenOptions } from "../src/agents/citizen";
import type { Action, Laws, Message, Observation, Outcome, Policy, Submit, SubmitTarget, Tick, WorldAction } from "../src/contracts";

const laws: Laws = {
    r: 0.1, K: 100_000, collapseAt: 0.1, maxHarvestFraction: 0.5, sigma: 0.05, upkeep: 100,
    prices: { harvest: 100, gift: 0, propose: 1000, vote: 100, delegate: 100, pair: 500, spawn: 2000 },
    starvationTicks: 3,
    maxMessagesPerTick: 3,
    maxMessageChars: 300,
};

const obs = (tick: Tick): Observation => ({
    tick,
    self: { id: "a", age: tick, balance: 1000, hungerTicks: 0 },
    citizenCount: 5,
    residents: ["a", "b", "c", "d", "e"],
    estimatedP: 50_000,
    laws,
});

const harvest = (amount: number): WorldAction[] => [{ type: "harvest", amount }];

// A stand-in for TurnCollector: records every submit, and lets a test wait for the n-th one.
function fakeCollector() {
    const submits: Submit[] = [];
    const waiting: { n: number; resolve: () => void }[] = [];
    const ref: SubmitTarget = {
        cast(msg) {
            submits.push(msg);
            for (const w of waiting.filter(w => submits.length >= w.n)) w.resolve();
            return true;
        },
    };
    // Resolves once n submits have arrived. A submit that never comes times the test out.
    const received = (n: number) => new Promise<Submit[]>(resolve => {
        if (submits.length >= n) return resolve(submits.slice(0, n));
        waiting.push({ n, resolve: () => resolve(submits.slice(0, n)) });
    });
    return { ref, submits, received };
}

// Lets every pending microtask run. pipeTo delivers a settled promise's result through a chain of
// microtasks, so after this the result message is in the Citizen's mailbox.
const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

// Every call into the Citizen's API is here, so a change to spawnCitizen or the tick message
// is a change in one place.
let system: Supervisor;
let crashes: unknown[];

function start(policy: Policy, options: CitizenOptions = {}) {
    crashes = [];
    system = new Supervisor({ onError: ({ error }) => { crashes.push(error); } });
    const citizen = spawnCitizen(system, "a", policy, options);
    const collector = fakeCollector();
    const tick = (n: Tick) => citizen.cast({ type: "tick", observation: obs(n), replyTo: collector.ref });
    return { citizen, collector, tick };
}

afterEach(() => {
    system.stop();
    vi.restoreAllMocks();
    // A handler that throws is a bug even when the supervisor restarts the actor.
    expect(crashes).toEqual([]);
});

describe("Citizen", () => {
    it('submits the policy\'s actions once per tick, from its own id and for that tick', async () => {
        const policy = vi.fn<Policy>(() => harvest(10));
        const { collector, tick } = start(policy);

        tick(0);
        expect(await collector.received(1)).toEqual([
            { type: "submit", from: "a", tick: 0, actions: harvest(10) },
        ]);
    });

    it('gives the policy the observation it was sent, and an empty inbox', async () => {
        const policy = vi.fn<Policy>(() => []);
        const { collector, tick } = start(policy);

        tick(3);
        await collector.received(1);
        expect(policy).toHaveBeenCalledTimes(1);
        expect(policy).toHaveBeenCalledWith(obs(3), [], { ticks: [] }, expect.any(AbortSignal));
    });

    it('waits for an async policy and submits its result', async () => {
        const policy = vi.fn<Policy>(() => new Promise(resolve => setTimeout(() => resolve(harvest(7)), 20)));
        const { collector, tick } = start(policy);

        tick(0);
        const [submit] = await collector.received(1);
        expect(submit?.actions).toEqual(harvest(7));
    });

    it('submits world actions as actions and says as messages; revise_values stays with the Citizen', async () => {
        const policy = vi.fn<Policy>(() => [
            { type: "say", to: "all", text: "let's share" },
            { type: "harvest", amount: 5 },
            { type: "revise_values", text: "share more", reason: "the pool is shrinking" },
        ]);
        const { collector, tick } = start(policy);

        tick(0);
        const [submit] = await collector.received(1);
        expect(submit?.actions).toEqual(harvest(5));
        expect(submit?.messages).toEqual([{ type: "say", to: "all", text: "let's share" }]);
    });

    it('a turn without says has no messages field', async () => {
        const { collector, tick } = start(vi.fn<Policy>(() => harvest(5)));

        tick(0);
        const [submit] = await collector.received(1);
        expect(submit).not.toHaveProperty("messages");
    });

    it('a throwing policy gives an empty turn with the reason, and the next tick works again', async () => {
        const policy = vi.fn<Policy>(() => harvest(10))
            .mockImplementationOnce(() => { throw new Error("boom"); });
        const { collector, tick } = start(policy);

        tick(0);
        await collector.received(1);
        tick(1);
        expect(await collector.received(2)).toEqual([
            { type: "submit", from: "a", tick: 0, actions: [], error: "boom" },
            { type: "submit", from: "a", tick: 1, actions: harvest(10) },
        ]);
    });

    it('a rejecting async policy gives an empty turn, whatever it rejects with', async () => {
        const policy = vi.fn<Policy>(() => Promise.reject("not even an Error"));
        const { collector, tick } = start(policy);

        tick(0);
        const [submit] = await collector.received(1);
        expect(submit).toEqual({ type: "submit", from: "a", tick: 0, actions: [], error: "not even an Error" });
    });

    it('drops a result that arrives after the next tick has started', async () => {
        // Tick 0's policy hangs until the test lets it finish; later ticks answer at once.
        let finishTick0!: (actions: WorldAction[]) => void;
        const policy = vi.fn<Policy>(() => harvest(2))
            .mockImplementationOnce(() => new Promise(resolve => { finishTick0 = resolve; }));
        const { collector, tick } = start(policy);

        tick(0);
        tick(1); // Runner gave up on tick 0 and moved on
        await collector.received(1);

        finishTick0(harvest(999)); // the late answer to tick 0
        await flushMicrotasks();   // its result message is now in the mailbox, ahead of tick 2
        tick(2);

        const submits = await collector.received(2);
        expect(submits.map(s => s.tick)).toEqual([1, 2]);
        expect(collector.submits.some(s => s.tick === 0)).toBe(false);
    });

    it('ignores a tick it has already seen, without running the policy again', async () => {
        const policy = vi.fn<Policy>(() => harvest(10));
        const { collector, tick } = start(policy);

        tick(0);
        await collector.received(1);
        tick(0); // a duplicate
        tick(1);
        // The mailbox is in order, so once tick 1 is submitted the duplicate has been handled.
        const submits = await collector.received(2);
        expect(submits.map(s => s.tick)).toEqual([0, 1]);
        expect(policy).toHaveBeenCalledTimes(2);
    });

    it('ignores a tick older than the last one', async () => {
        const policy = vi.fn<Policy>(() => harvest(10));
        const { collector, tick } = start(policy);

        tick(5);
        await collector.received(1);
        tick(4); // out of order
        tick(6);
        const submits = await collector.received(2);
        expect(submits.map(s => s.tick)).toEqual([5, 6]);
        expect(policy).toHaveBeenCalledTimes(2);
    });

    it('an ignored tick does not cost the current tick its submit', async () => {
        // Tick 5's policy is still thinking when a stray tick 4 arrives.
        let finishTick5!: (actions: WorldAction[]) => void;
        const policy = vi.fn<Policy>(() => new Promise(resolve => { finishTick5 = resolve; }));
        const { collector, tick } = start(policy);

        tick(5);
        tick(4);
        await vi.waitFor(() => expect(policy).toHaveBeenCalled()); // tick 5 is thinking
        finishTick5(harvest(10)); // tick 4 is handled before or after this; either way 5 must submit

        const [submit] = await collector.received(1);
        expect(submit?.tick).toBe(5);
    });

    it('a policy that returns something that is not a list of actions gives a failed turn, not a crash', async () => {
        // A glue bug: the type says Action[], the runtime disagrees.
        const policy = vi.fn<Policy>(() => undefined as unknown as Action[]);
        const { collector, tick } = start(policy);

        tick(0);
        const [submit] = await collector.received(1);
        expect(submit?.actions).toEqual([]);
        expect(submit?.error).toMatch(/^invalid policy output: /);
    });

    it('one invalid action fails the whole turn, with the reason', async () => {
        const policy = vi.fn<Policy>(() => [{ type: "harvest", amount: 5 }, { type: "harvest", amount: -1 }]);
        const { collector, tick } = start(policy);

        tick(0);
        const [submit] = await collector.received(1);
        expect(submit?.actions).toEqual([]);
        expect(submit?.error).toMatch(/invalid policy output: .*amount/);
    });

    it('a new tick aborts the previous call if it is still thinking', async () => {
        const signals: AbortSignal[] = [];
        const policy = vi.fn<Policy>((_o, _inbox, _memory, signal) => {
            signals.push(signal!);
            return signals.length === 1 ? new Promise(() => {}) : harvest(1); // tick 0 never answers
        });
        const { collector, tick } = start(policy);

        tick(0);
        tick(1);
        await collector.received(1);
        expect(signals.map(s => s.aborted)).toEqual([true, false]);
        expect(String(signals[0]?.reason)).toMatch(/superseded by tick 1/);
    });

    it('a call that already answered is not aborted by the next tick', async () => {
        const signals: AbortSignal[] = [];
        const policy = vi.fn<Policy>((_o, _inbox, _memory, signal) => { signals.push(signal!); return harvest(1); });
        const { collector, tick } = start(policy);

        tick(0);
        await collector.received(1);
        tick(1);
        await collector.received(2);
        expect(signals.map(s => s.aborted)).toEqual([false, false]);
    });

    it('aborting its lifetime aborts the call in flight', async () => {
        const lifetime = new AbortController();
        let seen: AbortSignal | undefined;
        const policy = vi.fn<Policy>((_o, _inbox, _memory, signal) => { seen = signal; return new Promise(() => {}); });
        const { tick } = start(policy, { lifetime: lifetime.signal });

        tick(0);
        await vi.waitFor(() => expect(policy).toHaveBeenCalled());
        expect(seen?.aborted).toBe(false);
        lifetime.abort(new Error("died"));
        expect(seen?.aborted).toBe(true);
    });
});

describe("Citizen memory", () => {
    const outcome = (tick: Tick): Outcome => ({
        tick, giftsReceived: [], giftsSent: [], ignored: [], upkeep: { paid: 100, due: 100 },
    });
    const memoryOf = (policy: ReturnType<typeof vi.fn<Policy>>, call: number) => policy.mock.calls[call]?.[2];

    it('keeps a record per tick: what it saw, what it chose, and the outcome, for the next policy call', async () => {
        const chosen: Action[] = [{ type: "harvest", amount: 10 }, { type: "say", to: "all", text: "hi" }];
        const policy = vi.fn<Policy>((o) => (o.tick === 0 ? chosen : []));
        const { citizen, collector, tick } = start(policy);

        tick(0);
        await collector.received(1);
        citizen.cast({ type: "outcome", outcome: outcome(0) });
        await flushMicrotasks();
        expect(policy).toHaveBeenCalledTimes(1); // storing an outcome does not run the policy

        tick(1);
        await collector.received(2);
        expect(memoryOf(policy, 0)).toEqual({ ticks: [] }); // nothing yet on the first tick
        expect(memoryOf(policy, 1)).toEqual({ ticks: [{
            tick: 0, estimatedP: 50_000, balance: 1000, actions: chosen, privateMessages: [], outcome: outcome(0),
        }] });
    });

    it('a failed turn is remembered with its reason', async () => {
        const policy = vi.fn<Policy>((o) => { if (o.tick === 0) throw new Error("boom"); return []; });
        const { collector, tick } = start(policy);

        tick(0);
        await collector.received(1);
        tick(1);
        await collector.received(2);
        expect(memoryOf(policy, 1)?.ticks[0]).toMatchObject({ tick: 0, failure: "boom" });
        expect(memoryOf(policy, 1)?.ticks[0]).not.toHaveProperty("actions");
    });

    it('a turn still thinking when the next tick starts is remembered as unanswered', async () => {
        const policy = vi.fn<Policy>((o) => (o.tick === 0 ? new Promise(() => {}) : []));
        const { collector, tick } = start(policy);

        tick(0);
        tick(1);
        await collector.received(1);
        expect(memoryOf(policy, 1)?.ticks[0]).toMatchObject({ tick: 0, failure: "no answer before the next tick" });
    });

    it('remembers private messages read on a tick, not broadcasts', async () => {
        const policy = vi.fn<Policy>(() => []);
        const { citizen, collector, tick } = start(policy);
        const toMe: Message = { from: "b", to: "a", tick: 0, text: "psst" };
        const toAll: Message = { from: "c", to: "all", tick: 0, text: "hello all" };

        citizen.cast({ type: "hear", messages: [toMe, toAll] });
        tick(1);
        await collector.received(1);
        tick(2);
        await collector.received(2);
        expect(memoryOf(policy, 1)?.ticks[0]?.privateMessages).toEqual([toMe]);
    });

    it('remembers only the last memoryTicks ticks, oldest first; an outcome for a forgotten tick is dropped', async () => {
        const policy = vi.fn<Policy>(() => []);
        const { citizen, collector, tick } = start(policy, { memoryTicks: 3 });

        for (let t = 0; t < 5; t++) {
            tick(t);
            await collector.received(t + 1);
        }
        citizen.cast({ type: "outcome", outcome: outcome(0) }); // tick 0 is forgotten by now
        tick(5);
        await collector.received(6);
        // At tick 5 it remembers ticks 2, 3 and 4: with tick 5's own record, that is 3.
        expect(memoryOf(policy, 5)?.ticks.map(r => r.tick)).toEqual([2, 3, 4]);
        expect(memoryOf(policy, 5)?.ticks.some(r => r.outcome)).toBe(false);
    });

    it('the policy gets a copy of the memory: changing it changes nothing in the Citizen', async () => {
        // Records what each call saw, then empties the list it was given.
        const seen: number[] = [];
        const policy = vi.fn<Policy>((_o, _inbox, memory) => {
            seen.push(memory?.ticks.length ?? -1);
            memory?.ticks.splice(0);
            return [];
        });
        const { collector, tick } = start(policy);

        tick(0);
        await collector.received(1);
        tick(1);
        await collector.received(2);
        tick(2);
        await collector.received(3);
        expect(seen).toEqual([0, 1, 2]);
    });
});

describe("Citizen inbox", () => {
    const message = (tick: Tick, text: string): Message => ({ from: "b", to: "a", tick, text });

    it('heard messages wait in the inbox until the next tick, and its policy call gets them', async () => {
        const policy = vi.fn<Policy>(() => []);
        const { citizen, collector, tick } = start(policy);

        citizen.cast({ type: "hear", messages: [message(0, "one")] });
        citizen.cast({ type: "hear", messages: [message(0, "two")] });
        await flushMicrotasks();
        expect(policy).not.toHaveBeenCalled(); // hearing runs nothing

        tick(1);
        await collector.received(1);
        expect(policy.mock.calls[0]?.[1]).toEqual([message(0, "one"), message(0, "two")]);
    });

    it('each message is shown once: the inbox empties when a tick starts', async () => {
        const policy = vi.fn<Policy>(() => []);
        const { citizen, collector, tick } = start(policy);

        citizen.cast({ type: "hear", messages: [message(0, "once")] });
        tick(1);
        await collector.received(1);
        tick(2);
        await collector.received(2);
        expect(policy.mock.calls.map(call => call[1].map(m => m.text))).toEqual([["once"], []]);
    });
});
