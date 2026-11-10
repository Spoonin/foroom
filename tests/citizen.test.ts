import { afterEach, describe, expect, it, vi } from "vitest";
import { Supervisor } from "@cue/core";
import { spawnCitizen } from "../src/agents/citizen";
import type { Laws, Observation, Policy, Submit, SubmitTarget, Tick, WorldAction } from "../src/contracts";

const laws: Laws = {
    r: 0.1, K: 100_000, collapseAt: 0.1, maxHarvestFraction: 0.5, sigma: 0.05, upkeep: 100,
    prices: { harvest: 100, gift: 0, propose: 1000, vote: 100, delegate: 100, pair: 500, spawn: 2000 },
    starvationTicks: 3,
};

const obs = (tick: Tick): Observation => ({
    tick,
    self: { id: "a", age: tick, balance: 1000, hungerTicks: 0 },
    citizenCount: 5,
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

function start(policy: Policy) {
    crashes = [];
    system = new Supervisor({ onError: ({ error }) => { crashes.push(error); } });
    const citizen = spawnCitizen(system, "a", policy);
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
        expect(policy).toHaveBeenCalledWith(obs(3), []);
    });

    it('waits for an async policy and submits its result', async () => {
        const policy = vi.fn<Policy>(() => new Promise(resolve => setTimeout(() => resolve(harvest(7)), 20)));
        const { collector, tick } = start(policy);

        tick(0);
        const [submit] = await collector.received(1);
        expect(submit?.actions).toEqual(harvest(7));
    });

    it('submits only world actions: local ones (say, revise_values) stay with the Citizen', async () => {
        const policy = vi.fn<Policy>(() => [
            { type: "say", to: "all", text: "let's share" },
            { type: "harvest", amount: 5 },
            { type: "revise_values", text: "share more", reason: "the pool is shrinking" },
        ]);
        const { collector, tick } = start(policy);

        tick(0);
        const [submit] = await collector.received(1);
        expect(submit?.actions).toEqual(harvest(5));
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
});
