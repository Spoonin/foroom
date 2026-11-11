import { it, expect } from "vitest";
import { regrow, allocate, resolve, netHarvest, observe } from "../src/world/world";
import type { WorldAction, WorldState } from "../src/contracts";

it('grows the world tick by logistics law', () => {
    const P = 500;
    const growLaws = { r: 0.1, K: 1000 }; // Example values for growth rate and carrying capacity
    const result = regrow(P, false, growLaws);
    expect(result).toBeCloseTo(525); // Adjust the expected value based on your implementation
});

it('does not grow at P = K', () => {
    const P = 1000;
    const growLaws = { r: 0.1, K: 1000 }; // Example values for growth rate and carrying capacity
    const result = regrow(P, false, growLaws);
    expect(result).toBeCloseTo(1000); // No growth at carrying capacity
});

it('does not grow when collapsed', () => {
    const P = 500;
    const growLaws = { r: 0.1, K: 1000 }; // Example values for growth rate and carrying capacity
    const result = regrow(P, true, growLaws);
    expect(result).toBeCloseTo(500); // No growth when collapsed
});

it('allocates resources correctly when total demand is within harvestable limit', () => {
    const P = 1000;
    const demands = [
        { id: "agent1", amount: 200 },
        { id: "agent2", amount: 300 }
    ];
    const harvestLaws = { maxHarvestFraction: 0.5 }; // 50% of P can be harvested

    const result = allocate(P, demands, harvestLaws);
    expect(result.allocated.get("agent1")).toBeCloseTo(200);
    expect(result.allocated.get("agent2")).toBeCloseTo(300);
    expect(result.remaining).toBeCloseTo(500); // Remaining pool after allocation
});

it('allocates resources proportionally when total demand exceeds harvestable limit', () => {
    const P = 1000;
    const demands = [
        { id: "agent1", amount: 600 },
        { id: "agent2", amount: 600 }
    ];
    const harvestLaws = { maxHarvestFraction: 0.5 }; // 50% of P can be harvested

    const result = allocate(P, demands, harvestLaws);
    const totalAllocated = result.allocated.get("agent1")! + result.allocated.get("agent2")!;
    expect(totalAllocated).toBeCloseTo(500); // Total allocated should equal harvestable amount
    expect(result.remaining).toBeCloseTo(500); // Remaining pool after allocation
});

it('throws an error for negative pool', () => {
    const P = -100;
    const demands = [{ id: "agent1", amount: 200 }];
    const harvestLaws = { maxHarvestFraction: 0.5 };

    expect(() => allocate(P, demands, harvestLaws)).toThrow("Pool must be non-negative");
});

it('throws an error for negative demand', () => {
    const P = 1000;
    const demands = [{ id: "agent1", amount: -200 }];
    const harvestLaws = { maxHarvestFraction: 0.5 };

    expect(() => allocate(P, demands, harvestLaws)).toThrow("Demands must be non-negative");
});

it('throws an error for duplicate agent ids', () => {
    const P = 1000;
    const demands = [
        { id: "agent1", amount: 200 },
        { id: "agent1", amount: 300 }
    ];
    const harvestLaws = { maxHarvestFraction: 0.5 };

    expect(() => allocate(P, demands, harvestLaws)).toThrow("Duplicate agent id in demands");
});

const laws = Object.freeze({
    r: 0.1,
    K: 1000,
    collapseAt: 0.1,
    maxHarvestFraction: 0.5,
    sigma: 0.05,
    upkeep: 1,
    prices: {
        harvest: 1,
        gift: 0,
        propose: 10,
        vote: 1,
        delegate: 1,
        pair: 5,
        spawn: 20
    },
    starvationTicks: 3,
    maxMessagesPerTick: 3,
    maxMessageChars: 300,
});

it('resolves world state correctly with valid actions', () => {
    const worldState = {
        seed: 1,
        tick: 0,
        P: 1000,
        collapsed: false,
        agents: new Map([
            ["agent1", { age: 1, balance: 100, hungerTicks: 0 }],
            ["agent2", { age: 1, balance: 100, hungerTicks: 0 }]
        ]),
        lifespans: new Map([["agent1", 10], ["agent2", 10]]),
    };

    const submissions = new Map([
        ["agent1", [{ type: "harvest" as const, amount: 200 }]],
        ["agent2", [{ type: "harvest" as const, amount: 300 }]]
    ]);

    const { state, report } = resolve(worldState, submissions, laws);
    expect(state.tick).toBe(1);
    expect(state.P).toBeGreaterThan(0);
    expect(report.invalid.size).toBe(0); // No invalid actions
});

it('agent with insufficient funds can harvest', () => {
    const worldState = {
        seed: 1,
        tick: 0,
        P: 1000,
        collapsed: false,
        agents: new Map([
            ["poor", { age: 1, balance: 0, hungerTicks: 0 }],
            ["rich", { age: 1, balance: 100, hungerTicks: 0 }]
        ]),
        lifespans: new Map([["poor", 10], ["rich", 10]]),
    };

    const submissions = new Map([
        ["poor", [{ type: "harvest" as const, amount: 200 }]],
        ["rich", [{ type: "harvest" as const, amount: 300 }]]
    ]);

    const { state, report } = resolve(worldState, submissions, laws);
    expect(state.tick).toBe(1);
    expect(state.P).toBeGreaterThan(0);
    expect(report.invalid.size).toBe(0); // No invalid actions
    expect(state.agents.get("poor")?.balance).toBeGreaterThan(0);
    expect(state.agents.get("poor")?.hungerTicks).toEqual(0);
});

it('agent dies after 3 ticks of hunger', () => {
    const worldState = {
        seed: 1,
        tick: 10,
        P: 0,
        collapsed: true,
        agents: new Map([
            ["poor", { age: 1, balance: 0, hungerTicks: 0 }],
            ["rich", { age: 1, balance: 100, hungerTicks: 0 }]
        ]),
        lifespans: new Map([["poor", 10], ["rich", 10]]),
    };

    const submissions = new Map([
        ["poor", [{ type: "harvest" as const, amount: 200 }]],
        ["rich", [{ type: "harvest" as const, amount: 300 }]]
    ]);

    const { state: tickOneState } = resolve(worldState, submissions, laws);
    const { state: tickTwoState } = resolve(tickOneState, submissions, laws);
    const { state: tickThreeState, report } = resolve(tickTwoState, submissions, laws);

    // Still alive after two starving ticks: death comes exactly on the third.
    expect(tickTwoState.agents.get("poor")?.hungerTicks).toBe(2);

    expect(tickThreeState.agents.get("poor")).toBeUndefined();
    expect(tickThreeState.agents.get("rich")).toBeDefined();
    expect(report.dead.has("poor")).toEqual(true);
    expect(report.dead.has("rich")).toEqual(false);
});
// ---- resolve: regressions found by probing (each of these failed before the fix) ----------------

const agent = (balance: number, hungerTicks = 0) => ({ age: 1, balance, hungerTicks });
const world = (P: number, agents: Record<string, ReturnType<typeof agent>>, collapsed = false): WorldState => ({
    seed: 1, tick: 0, P, collapsed,
    agents: new Map(Object.entries(agents)),
    lifespans: new Map(Object.keys(agents).map(id => [id, 100])),
});
const subs = (m: Record<string, WorldAction[]>) => new Map(Object.entries(m));

it('a broke agent pays the harvest fee from the yield, then upkeep', () => {
    const { state } = resolve(world(500, { broke: agent(0) }), subs({ broke: [{ type: "harvest", amount: 5 }] }), laws);
    // 5 harvested − 1 fee − 1 upkeep
    expect(state.agents.get("broke")?.balance).toBeCloseTo(3);
});

it('a yield smaller than the fee nets 0, never negative', () => {
    expect(netHarvest(0.4, 1)).toBe(0);
    expect(netHarvest(5, 1)).toBe(4);
});

it('resolve does not mutate its input state', () => {
    const input = world(500, { a: agent(0, 1), b: agent(10) });
    const snapshot = structuredClone(input);
    resolve(input, subs({ a: [{ type: "harvest", amount: 0 }], b: [{ type: "harvest", amount: 5 }] }), laws);
    expect(input).toEqual(snapshot);
});

it('hunger grows by exactly 1 per starving tick', () => {
    const { state } = resolve(world(0, { a: agent(0) }, true), subs({ a: [] }), laws);
    expect(state.agents.get("a")?.hungerTicks).toBe(1);
});

it('an agent with savings and no income is not starving', () => {
    const { state } = resolve(world(0, { saver: agent(50, 2) }, true), subs({ saver: [] }), laws);
    expect(state.agents.get("saver")?.hungerTicks).toBe(0);
    expect(state.agents.get("saver")?.balance).toBe(49);
});

it('several paid actions together cannot exceed the balance, and the balance never goes negative', () => {
    const votes: WorldAction[] = ["p", "q", "r"].map(proposalId => ({ type: "vote", proposalId, yes: true }));
    const { state, report } = resolve(world(500, { a: agent(2) }), subs({ a: votes }), laws);
    expect(report.charges.get("a")).toBe(2);
    expect(report.invalid.get("a")?.map(i => i.reason)).toEqual(["insufficient funds"]);
    expect(state.agents.get("a")?.balance).toBe(0); // 2 − 2 votes − upkeep clamped to what is left
});

it('a second harvest from the same agent is rejected as a duplicate', () => {
    const { report } = resolve(world(500, { a: agent(5) }),
        subs({ a: [{ type: "harvest", amount: 5 }, { type: "harvest", amount: 50 }] }), laws);
    expect(report.harvested.get("a")).toBe(5);
    expect(report.invalid.get("a")?.map(i => i.reason)).toEqual(["duplicate"]);
});

it('the pool regrows after harvest', () => {
    const { state } = resolve(world(500, { a: agent(10) }), subs({ a: [] }), laws);
    expect(state.P).toBeCloseTo(525); // 500 + 0.1 · 500 · (1 − 500/1000)
});

it('collapse is permanent even if the pool rises again', () => {
    const { state: collapsed } = resolve(world(90, { a: agent(100) }), subs({ a: [] }), laws);
    expect(collapsed.collapsed).toBe(true);
    const { state: later } = resolve({ ...collapsed, P: 500 }, subs({ a: [] }), laws);
    expect(later.collapsed).toBe(true);
    expect(later.P).toBe(500); // no regrowth
});

it('a gift is paid by the giver, credited to the recipient, and counts as income', () => {
    const { state, report } = resolve(world(0, { giver: agent(20), taker: agent(0, 2) }, true),
        subs({ giver: [{ type: "gift", to: "taker", amount: 5 }] }), laws);
    expect(report.received.get("taker")).toBe(5);
    expect(state.agents.get("giver")?.balance).toBe(14); // 20 − 5 − upkeep 1 (gift price is 0)
    expect(state.agents.get("taker")?.balance).toBe(4);  // 0 + 5 − upkeep 1
    expect(state.agents.get("taker")?.hungerTicks).toBe(0);
});

it('a gift to an unknown agent is rejected', () => {
    const { report } = resolve(world(500, { a: agent(20) }), subs({ a: [{ type: "gift", to: "ghost", amount: 5 }] }), laws);
    expect(report.invalid.get("a")?.map(i => i.reason)).toEqual(["unknown recipient"]);
});

// ---- integer credits ----------------------------------------------------------------------------

it('allocate floors shares to whole credits and leaves the leftover in the pool', () => {
    // harvestable = floor(101 · 0.5) = 50; three equal demands get floor(50/3) = 16 each
    const result = allocate(101, [
        { id: "a", amount: 100 }, { id: "b", amount: 100 }, { id: "c", amount: 100 },
    ], { maxHarvestFraction: 0.5 });
    for (const share of result.allocated.values()) {
        expect(Number.isInteger(share)).toBe(true);
        expect(share).toBe(16);
    }
    expect(result.remaining).toBe(101 - 48); // the 2 credits lost to flooring stay in the pool
});

it('regrow returns whole credits', () => {
    expect(regrow(333, false, { r: 0.1, K: 1000 })).toBe(355); // 333 + floor(22.2111)
});

it('resolve keeps P and every balance whole after a scarce, uneven split', () => {
    const { state } = resolve(world(1001, { a: agent(250), b: agent(250), c: agent(250) }), subs({
        a: [{ type: "harvest", amount: 333 }],
        b: [{ type: "harvest", amount: 500 }],
        c: [{ type: "harvest", amount: 77 }],
    }), laws);
    expect(Number.isInteger(state.P)).toBe(true);
    for (const a of state.agents.values()) expect(Number.isInteger(a.balance)).toBe(true);
});

// ---- old age ------------------------------------------------------------------------------------

it('an agent dies of old age when its age reaches its lifespan, and its lifespan is dropped', () => {
    const state = world(500, { old: agent(1000), young: agent(1000) });
    state.lifespans.set("old", 2); // age 1 → 2 this tick
    const { state: next, report } = resolve(state, subs({}), laws);
    expect(report.dead.get("old")).toBe("age");
    expect(next.agents.has("old")).toBe(false);
    expect(next.lifespans.has("old")).toBe(false);
    expect(next.lifespans.get("young")).toBe(100);
});

// ---- observe ------------------------------------------------------------------------------------

const observed = (P: number, ids: string[], seed = 1, tick = 0): WorldState => ({
    ...world(P, Object.fromEntries(ids.map(id => [id, agent(10)]))), seed, tick,
});

it('observe gives each agent a whole, non-negative estimate close to P', () => {
    for (const obs of observe(observed(50_000, ["a", "b", "c"]), laws).values()) {
        expect(Number.isInteger(obs.estimatedP)).toBe(true);
        expect(obs.estimatedP).toBeGreaterThan(50_000 * 0.7);
        expect(obs.estimatedP).toBeLessThan(50_000 * 1.3);
    }
});

it('observe lists the living residents, sorted, in a copy per agent', () => {
    const observations = observe(observed(50_000, ["c", "a", "b"]), laws);
    const a = observations.get("a")!;
    const b = observations.get("b")!;

    expect(a.residents).toEqual(["a", "b", "c"]);
    expect(a.residents).not.toBe(b.residents); // a policy that mutates its list changes no one else's
});

it('agents in the same tick get different estimates', () => {
    const estimates = [...observe(observed(50_000, ["a", "b", "c"]), laws).values()].map(o => o.estimatedP);
    expect(new Set(estimates).size).toBe(3);
});

it('an agent gets a new estimate every tick', () => {
    const t0 = observe(observed(50_000, ["a"], 1, 0), laws).get("a")!.estimatedP;
    const t1 = observe(observed(50_000, ["a"], 1, 1), laws).get("a")!.estimatedP;
    expect(t0).not.toBe(t1);
});

it('estimates depend only on (seed, tick, agent), not on the order agents were added', () => {
    const forward = observe(observed(50_000, ["a", "b", "c"]), laws);
    const backward = observe(observed(50_000, ["c", "b", "a"]), laws);
    for (const id of ["a", "b", "c"]) {
        expect(backward.get(id)!.estimatedP).toBe(forward.get(id)!.estimatedP);
    }
});

it('a different run seed gives different estimates', () => {
    const one = observe(observed(50_000, ["a"], 1), laws).get("a")!.estimatedP;
    const two = observe(observed(50_000, ["a"], 2), laws).get("a")!.estimatedP;
    expect(one).not.toBe(two);
});

it('observe shows the agent its own state, but not its lifespan or the exact P', () => {
    const state = observed(50_000, ["a"]);
    const obs = observe(state, laws).get("a")!;
    expect(obs.self).toEqual({ id: "a", age: 1, balance: 10, hungerTicks: 0 });
    expect(obs.self).not.toHaveProperty("lifespan");
    expect(obs).not.toHaveProperty("lifespan");
    expect(obs).not.toHaveProperty("P");
});

it('dead agents get no observation', () => {
    const { state } = resolve(observed(50_000, ["a", "b"]), subs({}), laws);
    state.agents.delete("b");
    expect([...observe(state, laws).keys()]).toEqual(["a"]);
});

// ---- hunger: a tick is hungry when upkeep was not paid in full ----------------------------------
// Laws at the real scale (K 100 000, upkeep 100, fee 100), so a partial payment is visible.
const hungerLaws = Object.freeze({ ...laws, K: 100_000, upkeep: 100, prices: { ...laws.prices, harvest: 100 } });
const starve = (state: WorldState, turn: Record<string, WorldAction[]>, ticks: number) => {
    let s = state;
    for (let t = 0; t < ticks && s.agents.size; t++) s = resolve(s, subs(turn), hungerLaws).state;
    return s;
};

it('income that does not cover upkeep is a hungry tick', () => {
    const { state } = resolve(world(50_000, { a: agent(0) }), subs({ a: [{ type: "harvest", amount: 101 }] }), hungerLaws);
    expect(state.agents.get("a")).toMatchObject({ balance: 0, hungerTicks: 1 }); // net 1 paid 1 of 100
});

it('harvesting just above the fee no longer keeps an agent alive', () => {
    const state = starve(world(50_000, { a: agent(0) }), { a: [{ type: "harvest", amount: 101 }] }, 10);
    expect(state.agents.has("a")).toBe(false);
});

it('a patron giving 1 credit a tick cannot keep a client alive; covering the upkeep can', () => {
    const cheap = starve(world(50_000, { patron: agent(100_000), client: agent(0) }), { patron: [{ type: "gift", to: "client", amount: 1 }] }, 10);
    expect([...cheap.agents.keys()]).toEqual(["patron"]);
    const full = starve(world(50_000, { patron: agent(100_000), client: agent(0) }), { patron: [{ type: "gift", to: "client", amount: 100 }] }, 10);
    expect([...full.agents.keys()]).toEqual(["patron", "client"]);
    expect(full.agents.get("client")).toMatchObject({ balance: 0, hungerTicks: 0 });
});

it('savings of exactly one upkeep pay it in full: not hungry, even with nothing left after', () => {
    const { state } = resolve(world(50_000, { saver: agent(100, 2) }), subs({ saver: [] }), hungerLaws);
    expect(state.agents.get("saver")).toMatchObject({ balance: 0, hungerTicks: 0 });
});

it('upkeep plus the harvest fee, from the pool, is exactly enough to live', () => {
    const state = starve(world(50_000, { a: agent(0) }), { a: [{ type: "harvest", amount: 200 }] }, 10);
    expect(state.agents.get("a")).toMatchObject({ balance: 0, hungerTicks: 0 });
});

// ---- outcomes: what each agent learns about its own actions ------------------------------------

it('an outcome shows a scaled-down harvest: asked, got and net after the fee', () => {
    // Harvestable is 50% of 100 = 50; demand is 100, so everyone gets half of what they asked.
    const { report } = resolve(world(100, { a: agent(10), b: agent(10) }),
        subs({ a: [{ type: "harvest", amount: 60 }], b: [{ type: "harvest", amount: 40 }] }), laws);
    expect(report.outcomes.get("a")?.harvest).toEqual({ asked: 60, got: 30, net: 29 });
    expect(report.outcomes.get("b")?.harvest).toEqual({ asked: 40, got: 20, net: 19 });
});

it('an outcome names who gave what, on both sides of a gift', () => {
    const { report } = resolve(world(0, { x: agent(20), giver: agent(20), taker: agent(5) }, true),
        subs({ x: [{ type: "gift", to: "taker", amount: 3 }], giver: [{ type: "gift", to: "taker", amount: 5 }] }), laws);
    expect(report.outcomes.get("taker")?.giftsReceived).toEqual([{ from: "giver", amount: 5 }, { from: "x", amount: 3 }]);
    expect(report.outcomes.get("giver")?.giftsSent).toEqual([{ to: "taker", amount: 5 }]);
    expect(report.gifts).toEqual([
        { from: "giver", to: "taker", amount: 5 },
        { from: "x", to: "taker", amount: 3 },
    ]);
});

it('an outcome lists the agent\'s ignored actions with their reasons', () => {
    const ghostGift: WorldAction = { type: "gift", to: "ghost", amount: 5 };
    const { report } = resolve(world(500, { a: agent(20) }), subs({ a: [ghostGift] }), laws);
    expect(report.outcomes.get("a")?.ignored).toEqual([{ action: ghostGift, reason: "unknown recipient" }]);
});

it('an outcome has the agent\'s own facts only, and no harvest when it did not harvest', () => {
    const { report } = resolve(world(500, { a: agent(20), b: agent(20), c: agent(20) }),
        subs({ b: [{ type: "harvest", amount: 10 }, { type: "gift", to: "c", amount: 2 }] }), laws);
    expect(report.outcomes.get("a")).toEqual({
        tick: 0, giftsReceived: [], giftsSent: [], ignored: [], upkeep: { paid: 1, due: 1 },
    });
});

it('an outcome shows upkeep paid against upkeep due', () => {
    const { report } = resolve(world(0, { broke: agent(0) }, true), subs({}), laws);
    expect(report.outcomes.get("broke")?.upkeep).toEqual({ paid: 0, due: 1 });
});

it('an agent that died this tick gets no outcome', () => {
    const { report } = resolve(world(0, { starving: agent(0, 2), fed: agent(20) }, true), subs({}), laws);
    expect(report.dead.has("starving")).toBe(true);
    expect([...report.outcomes.keys()]).toEqual(["fed"]);
});
