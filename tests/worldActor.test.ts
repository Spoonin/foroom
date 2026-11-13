// The World actor: a thin Server over observe/resolve. These tests check the wiring through cue,
// the world math itself is covered in world.test.ts.
import { describe, expect, it } from "vitest";
import { Supervisor } from "@cue/core";
import { createWorld, spawnWorld } from "../src/world/world";
import type { Laws, WorldAction, WorldState } from "../src/contracts";

const laws: Laws = {
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
};

function setup(initial: WorldState = createWorld(1, ["a", "b"], laws)) {
    const errors: unknown[] = [];
    const system = new Supervisor({ onError: (crash) => { errors.push(crash.error); } }, { policy: "escalate" });
    const world = spawnWorld(system, initial, laws);
    return { system, world, errors };
}

const subs = (m: Record<string, WorldAction[]>) => new Map(Object.entries(m));

describe("World actor", () => {
    it('createWorld starts at tick 0 with P = K/2 and equal balances', () => {
        const state = createWorld(7, ["a", "b"], laws);
        expect(state).toMatchObject({ seed: 7, tick: 0, P: 50_000, collapsed: false });
        expect(state.agents.get("a")).toEqual({ age: 0, balance: 1000, hungerTicks: 0 });
        expect(state.lifespans.get("b")).toBe(Infinity);
        expect(() => createWorld(1, ["a", "a"], laws)).toThrow("Duplicate agent id");
    });

    it('resolve then observe shows the next tick with the harvest applied', async () => {
        const { system, world } = setup();
        const before = await world.call({ type: "observe" });
        expect(before.get("a")!.tick).toBe(0);

        const report = await world.call({ type: "resolve", submissions: subs({ a: [{ type: "harvest", amount: 300 }] }) });
        expect(report.harvested.get("a")).toBe(300);

        const after = await world.call({ type: "observe" });
        expect(after.get("a")!.tick).toBe(1);
        expect(after.get("a")!.self.balance).toBe(1000 + 300 - 100 - 100); // + harvest − fee − upkeep
        system.stop();
    });

    it('state is kept between calls: two resolves advance two ticks', async () => {
        const { system, world } = setup();
        await world.call({ type: "resolve", submissions: subs({}) });
        await world.call({ type: "resolve", submissions: subs({}) });
        expect((await world.call({ type: "observe" })).get("a")!.tick).toBe(2);
        system.stop();
    });

    it('a NaN or fractional harvest is rejected and does not poison anyone else', async () => {
        const { system, world } = setup();
        const report = await world.call({ type: "resolve", submissions: subs({
            a: [{ type: "harvest", amount: NaN }],
            b: [{ type: "harvest", amount: 100.5 }],
        }) });
        expect(report.invalid.get("a")?.map(i => i.reason)).toEqual(["not whole credits"]);
        expect(report.invalid.get("b")?.map(i => i.reason)).toEqual(["not whole credits"]);

        const obs = await world.call({ type: "observe" });
        for (const o of obs.values()) {
            expect(Number.isInteger(o.self.balance)).toBe(true);
            expect(Number.isInteger(o.estimatedP)).toBe(true);
        }
        system.stop();
    });

    it('a policy mutating its laws does not change them for anyone else', async () => {
        const { system, world } = setup();
        const first = await world.call({ type: "observe" });
        first.get("a")!.laws.prices.vote = 0;
        expect(first.get("b")!.laws.prices.vote).toBe(100);
        expect((await world.call({ type: "observe" })).get("a")!.laws.prices.vote).toBe(100);
        system.stop();
    });

    it('under "escalate", a crash in resolve reaches onError and does not rewind the world', async () => {
        // A state without a lifespan for "b" makes resolve throw: a bug in whoever built the state.
        const atTick1 = { ...createWorld(1, ["a", "b"], laws), tick: 1 };
        atTick1.lifespans.delete("b");
        const { system, world, errors } = setup(atTick1);

        await expect(world.call({ type: "resolve", submissions: subs({}) })).rejects.toThrow("No lifespan for agent b");
        await new Promise(resolve => setTimeout(resolve, 20));
        expect(errors.map(String)).toEqual(["Error: No lifespan for agent b"]);
        // Still at tick 1: the actor kept its state instead of restarting from scratch.
        expect((await world.call({ type: "observe" })).get("a")!.tick).toBe(1);
        system.stop();
    });
});
