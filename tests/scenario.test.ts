// Whole runs through the real actors: World, Ledger, TurnCollector, Citizens and Runner.
// policies.test.ts checks the same economics on the pure functions; this checks the wiring.

import { describe, expect, it } from "vitest";
import { runSimulation, type CitizenSpec } from "../src/world/runner";
import { ofKind } from "../src/world/ledger";
import { tickRows, toCsv } from "../src/metrics/timeseries";
import { fairSharePolicy } from "../src/agents/policies/fairShare";
import { greedyPolicy } from "../src/agents/policies/greedy";
import { makeRandomPolicy } from "../src/agents/policies/random";
import { deriveSeed, rng } from "../src/rng";
import type { Laws, Policy } from "../src/contracts";

const laws: Laws = Object.freeze({
    r: 0.1, K: 100_000, collapseAt: 0.1, maxHarvestFraction: 0.5, sigma: 0.05, upkeep: 100,
    prices: { harvest: 100, gift: 0, propose: 1000, vote: 100, delegate: 100, pair: 500, spawn: 2000 },
    starvationTicks: 3,
});

const ids = ["a", "b", "c", "d", "e"];
const all = (policy: Policy): CitizenSpec[] => ids.map(id => ({ id, policy }));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe("scenarios", () => {
    it('5 × greedy collapse the pool before tick 50', async () => {
        const { events, collapsed } = await runSimulation({ seed: 1, ticks: 50, citizens: all(greedyPolicy), laws });
        expect(collapsed).toBe(true);
        const first = ofKind(events, "pool").find(e => e.collapsed);
        expect(first?.tick).toBeLessThan(50);
    });

    it('5 × fairShare keep P above the collapse threshold for 250 ticks, and nobody dies', async () => {
        const { events, ticksRun, survivors } = await runSimulation({ seed: 1, ticks: 250, citizens: all(fairSharePolicy), laws });
        expect(ticksRun).toBe(250);
        expect(survivors).toEqual(ids);
        expect(ofKind(events, "death")).toEqual([]);
        expect(ofKind(events, "timeout")).toEqual([]);
        for (const { tick, P } of ofKind(events, "pool")) {
            expect(P, `P on tick ${tick}`).toBeGreaterThan(laws.collapseAt * laws.K);
        }
    });

    it('one seed gives one CSV: two runs of seeded random agents are identical', async () => {
        const run = async (seed: number) => {
            const citizens = ids.map(id => ({ id, policy: makeRandomPolicy(rng(deriveSeed(seed, `policy:${id}`))) }));
            const { events } = await runSimulation({ seed, ticks: 40, citizens, laws });
            return toCsv(tickRows(events, ids.length));
        };
        const first = await run(7);
        expect(await run(7)).toBe(first);
        expect(await run(8)).not.toBe(first);
    });

    it('an agent that misses the deadline gets an empty turn and a timeout, and the run goes on', async () => {
        const slow: Policy = async (o) => { await sleep(100); return fairSharePolicy(o, []); };
        const citizens = [...all(fairSharePolicy).slice(0, 2), { id: "slow", policy: slow }];
        const { events, ticksRun } = await runSimulation({ seed: 1, ticks: 3, citizens, laws, turnDeadlineMs: 30 });

        expect(ticksRun).toBe(3);
        expect(ofKind(events, "timeout")).toEqual([0, 1, 2].map(tick => ({ tick, kind: "timeout", agent: "slow" })));
        // Its late answers never reach the World.
        expect(ofKind(events, "harvest").filter(e => e.agent === "slow")).toEqual([]);
        expect(ofKind(events, "harvest").filter(e => e.agent !== "slow")).toHaveLength(6);
    });

    it('a failing policy is recorded with its reason, and the agent still pays upkeep', async () => {
        const broken: Policy = () => { throw new Error("cannot parse model output"); };
        const citizens = [{ id: "a", policy: fairSharePolicy }, { id: "b", policy: broken }];
        const { events } = await runSimulation({ seed: 1, ticks: 2, citizens, laws });

        expect(ofKind(events, "policyFailed")).toEqual([0, 1].map(tick =>
            ({ tick, kind: "policyFailed", agent: "b", reason: "cannot parse model output" })));
        expect(ofKind(events, "upkeep").filter(e => e.agent === "b")).toHaveLength(2);
    });

    it('agents with nothing to eat starve, are stopped, and the run ends early', async () => {
        const idle: Policy = () => [];
        const { events, ticksRun, survivors } = await runSimulation({
            seed: 1, ticks: 100, citizens: all(idle), laws, start: { balance: 0 },
        });
        expect(survivors).toEqual([]);
        expect(ticksRun).toBe(laws.starvationTicks);
        expect(ofKind(events, "death").map(e => e.reason)).toEqual(ids.map(() => "hunger"));
    });

    it('the CSV has one row per tick, with P(t) and the population', async () => {
        const { events } = await runSimulation({ seed: 1, ticks: 3, citizens: all(fairSharePolicy), laws });
        const lines = toCsv(tickRows(events, ids.length)).trim().split("\n");
        expect(lines[0]).toBe("tick,P,collapsed,alive,harvested,deaths,timeouts,policyFailures");
        expect(lines).toHaveLength(4);
        expect(lines[1]).toMatch(/^0,\d+,false,5,\d+,0,0,0$/);
    });
});

describe("stopping a run with an AbortSignal", () => {
    it('stops after the tick on which it was aborted, and returns what it has', async () => {
        const controller = new AbortController();
        const result = await runSimulation({
            seed: 1, ticks: 100, citizens: all(fairSharePolicy), laws, signal: controller.signal,
            onTick: (report) => { if (report.tick === 4) controller.abort(); },
        });
        expect(result.aborted).toBe(true);
        expect(result.ticksRun).toBe(5);
        expect(ofKind(result.events, "pool").map(e => e.tick)).toEqual([0, 1, 2, 3, 4]);
        expect(result.survivors).toEqual(ids);
    });

    it('does not wait out the turn deadline, and abandons the unfinished tick', async () => {
        const thinking: Policy = () => new Promise(() => {}); // never answers
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 50);

        const started = performance.now();
        const result = await runSimulation({
            seed: 1, ticks: 10, citizens: all(thinking), laws, signal: controller.signal, turnDeadlineMs: 60_000,
        });
        expect(performance.now() - started).toBeLessThan(1000);
        expect(result.ticksRun).toBe(0);
        // Nothing of the abandoned tick: no pool event, and no false timeouts.
        expect(result.events).toEqual([]);
    });

    it('an already aborted signal runs nothing', async () => {
        const result = await runSimulation({ seed: 1, ticks: 10, citizens: all(fairSharePolicy), laws, signal: AbortSignal.abort() });
        expect(result).toMatchObject({ aborted: true, ticksRun: 0, events: [] });
    });

    it('one controller stops many runs at once', async () => {
        const controller = new AbortController();
        const slow: Policy = async (o) => { await sleep(10); return fairSharePolicy(o, []); };
        const runs = [1, 2, 3].map(seed => runSimulation({ seed, ticks: 1000, citizens: all(slow), laws, signal: controller.signal }));
        setTimeout(() => controller.abort(), 100);

        const results = await Promise.all(runs);
        for (const r of results) {
            expect(r.aborted).toBe(true);
            expect(r.ticksRun).toBeGreaterThan(0);
            expect(r.ticksRun).toBeLessThan(1000);
        }
    });

    it('a run that finishes on its own is not aborted', async () => {
        const { aborted } = await runSimulation({ seed: 1, ticks: 2, citizens: all(fairSharePolicy), laws });
        expect(aborted).toBe(false);
    });
});
