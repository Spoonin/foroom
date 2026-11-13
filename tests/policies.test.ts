import { emptyForum } from "../src/world/forum";
import { it, expect, describe } from "vitest";
import { fairShareAmount, fairSharePolicy, makeStewardPolicy, subsistenceAmount, TROUBLE_AT } from "../src/agents/policies/fairShare";
import { makeRandomPolicy } from "../src/agents/policies/random";
import { greedyPolicy, makeGreedyPolicy } from "../src/agents/policies/greedy";
import { rng } from "../src/rng";
import { createWorld, observe, resolve } from "../src/world/world";
import type { Action, Laws, Observation, WorldAction, WorldState } from "../src/contracts";

// The test's own laws, the same shape as config.ts: tuning config must not break these tests.
const laws: Laws = Object.freeze({
    r: 0.1,
    K: 100_000,
    collapseAt: 0.1,
    maxHarvestFraction: 0.5,
    sigma: 0.05,
    upkeep: 100,
    prices: { harvest: 100, gift: 0, propose: 1000, vote: 100, delegate: 100, judge: 0, pair: 500, spawn: 2000 },
    starvationTicks: 3,
    maxMessagesPerTick: 3,
    maxMessageChars: 300,
    quorum: 0.5,
    punishShare: 2 / 3,
    detectionChance: 0.5,
    maxFineMultiple: 3,
});

const obs = (estimatedP: number, citizenCount: number, balance = 1000): Observation => ({
    tick: 0,
    self: { id: "me", age: 1, balance, hungerTicks: 0 },
    citizenCount,
    residents: Array.from({ length: citizenCount }, (_, i) => (i === 0 ? "me" : `other-${i}`)),
    estimatedP,
    laws,
    forum: { quota: null, proposals: [], cases: [], myDelegate: null, news: null }, flows: null,
});

// Rule-based policies are synchronous; this unwraps the single harvest amount.
function harvestOf(actions: Action[] | Promise<Action[]>): number {
    if (actions instanceof Promise) throw new Error("rule-based policies must be synchronous");
    const harvest = actions.find(a => a.type === "harvest");
    if (!harvest || harvest.type !== "harvest") throw new Error("no harvest action");
    return harvest.amount;
}

describe("fairShare", () => {
    // At P = K/2 regrowth is r·K/4 = 2500, so with 5 agents a fair share is 500.
    const fullShare = (laws.r * laws.K) / 4 / 5;

    it('takes at most its share of the regrowth at P = K/2, but not much less', () => {
        const amount = harvestOf(fairSharePolicy(obs(laws.K / 2, 5), []));
        expect(amount).toBeLessThanOrEqual(fullShare);
        // A safety margin is fine; taking almost nothing is not "fair share" either.
        expect(amount).toBeGreaterThanOrEqual(fullShare * 0.8);
    });

    it('asks for a whole number of credits', () => {
        for (const P of [45_678, 50_000, 77_777]) {
            expect(Number.isInteger(harvestOf(fairSharePolicy(obs(P, 7), [])))).toBe(true);
        }
    });

    it('takes half as much when there are twice as many agents', () => {
        const five = harvestOf(fairSharePolicy(obs(laws.K / 2, 5), []));
        const ten = harvestOf(fairSharePolicy(obs(laws.K / 2, 10), []));
        expect(Math.abs(ten - five / 2)).toBeLessThanOrEqual(1); // ±1 for flooring
    });

    it('never asks for a negative amount, even at an estimate above K', () => {
        // Above K the logistic formula gives negative regrowth.
        expect(harvestOf(fairSharePolicy(obs(laws.K * 1.1, 5), []))).toBeGreaterThanOrEqual(0);
    });

    describe("when the pool is in trouble (estimate below TROUBLE_AT · K)", () => {
        const low = TROUBLE_AT * laws.K - 1;

        it('takes its fair share right at the edge of trouble', () => {
            expect(harvestOf(fairSharePolicy(obs(TROUBLE_AT * laws.K, 5), []))).toBe(fairShareAmount(obs(TROUBLE_AT * laws.K, 5)));
        });

        it('lives on savings: harvests nothing while its balance covers a full upkeep', () => {
            expect(fairSharePolicy(obs(low, 5, laws.upkeep), [])).toEqual([]);
            expect(fairSharePolicy(obs(laws.collapseAt * laws.K / 2, 5, 5000), [])).toEqual([]); // even when collapsed
        });

        it('out of savings, harvests only the minimum for living: upkeep plus the harvest fee', () => {
            for (const balance of [0, laws.upkeep - 1]) {
                expect(harvestOf(fairSharePolicy(obs(low, 5, balance), []))).toBe(laws.upkeep + laws.prices.harvest);
            }
        });

        it('the minimum for living leaves it exactly even: net income pays the upkeep', () => {
            const state = createWorld(1, ["me"], laws, { P: 20_000, balance: 0 });
            const amount = subsistenceAmount(obs(20_000, 1, 0));
            const { state: next, report } = resolve(state, new Map([["me", [{ type: "harvest", amount }]]]), laws);
            expect(report.dead.size).toBe(0);
            expect(next.agents.get("me")).toMatchObject({ balance: 0, hungerTicks: 0 });
        });

        it('the trouble threshold can be set', () => {
            expect(makeStewardPolicy(0.6)(obs(0.55 * laws.K, 5), [])).toEqual([]);
            expect(harvestOf(makeStewardPolicy(0.5)(obs(0.55 * laws.K, 5), []))).toBe(fairShareAmount(obs(0.55 * laws.K, 5)));
        });
    });

    it('5 × fairShare keep the pool alive for 250 ticks, and nobody starves', () => {
        const ids = ["a", "b", "c", "d", "e"];
        let state: WorldState = {
            seed: 1,
            tick: 0,
            P: laws.K / 2,
            collapsed: false,
            agents: new Map(ids.map(id => [id, { age: 0, balance: 1000, hungerTicks: 0 }])),
            lifespans: new Map(ids.map(id => [id, Infinity])), // immortal in step 2
            forum: emptyForum(),
            news: null,
            flows: null,
        };

        for (let t = 0; t < 250; t++) {
            const submissions = new Map<string, WorldAction[]>();
            for (const [id, o] of observe(state, laws)) {
                submissions.set(id, fairSharePolicy(o, []) as WorldAction[]);
            }
            const { state: next, report } = resolve(state, submissions, laws);
            expect(report.dead.size, `someone died on tick ${t}`).toBe(0);
            expect(next.collapsed, `collapsed on tick ${t}`).toBe(false);
            state = next;
        }
        expect(state.P).toBeGreaterThan(laws.collapseAt * laws.K);
        expect(state.agents.size).toBe(5);
    });
});

describe("random", () => {
    const o = obs(laws.K / 2, 5);
    const fair = fairShareAmount(o);
    const draws = (seed: number, n: number) => {
        const policy = makeRandomPolicy(rng(seed));
        return Array.from({ length: n }, () => harvestOf(policy(o, [])));
    };

    it('harvests a whole amount between 0 and 2 × the fair share', () => {
        for (const amount of draws(1, 1000)) {
            expect(Number.isInteger(amount)).toBe(true);
            expect(amount).toBeGreaterThanOrEqual(0);
            expect(amount).toBeLessThanOrEqual(2 * fair);
        }
    });

    it('is fair on average', () => {
        const amounts = draws(2, 10_000);
        const mean = amounts.reduce((a, b) => a + b, 0) / amounts.length;
        expect(Math.abs(mean - fair)).toBeLessThan(fair * 0.05);
    });

    it('the same seed gives the same harvests', () => {
        expect(draws(3, 20)).toEqual(draws(3, 20));
    });

    it('different seeds give different harvests', () => {
        expect(draws(4, 20)).not.toEqual(draws(5, 20));
    });

    it('respects maxFactor', () => {
        const policy = makeRandomPolicy(rng(6), 0.5);
        for (let i = 0; i < 1000; i++) {
            expect(harvestOf(policy(o, []))).toBeLessThanOrEqual(fair * 0.5);
        }
    });
});

describe("greedy", () => {
    const o = obs(laws.K / 2, 5);

    it('takes factor × the fair share, in whole credits', () => {
        expect(harvestOf(greedyPolicy(o, []))).toBe(3 * fairShareAmount(o));
        expect(harvestOf(makeGreedyPolicy(2.5)(o, []))).toBe(Math.floor(2.5 * fairShareAmount(o)));
    });

    it('5 × greedy collapse the pool before tick 50', () => {
        let state = createWorld(1, ["a", "b", "c", "d", "e"], laws);
        let collapsedAt: number | null = null;
        for (let t = 0; t < 50 && collapsedAt === null; t++) {
            const submissions = new Map<string, WorldAction[]>();
            for (const [id, o] of observe(state, laws)) {
                submissions.set(id, greedyPolicy(o, []) as WorldAction[]);
            }
            state = resolve(state, submissions, laws).state;
            if (state.collapsed) collapsedAt = t;
        }
        expect(collapsedAt).not.toBeNull();
    });
});
