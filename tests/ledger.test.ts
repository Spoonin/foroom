import { describe, expect, it } from "vitest";
import { Supervisor } from "@cue/core";
import { eventsFromReport, ofKind, readAll, record, spawnLedger, type LedgerEvent } from "../src/world/ledger";
import { createWorld, resolve } from "../src/world/world";
import type { Laws, Report, WorldAction } from "../src/contracts";

const laws: Laws = {
    r: 0.1, K: 100_000, collapseAt: 0.1, maxHarvestFraction: 0.5, sigma: 0.05, upkeep: 100,
    prices: { harvest: 100, gift: 0, propose: 1000, vote: 100, delegate: 100, judge: 0, pair: 500, spawn: 2000 },
    starvationTicks: 3,
    maxMessagesPerTick: 3,
    maxMessageChars: 300,
    quorum: 0.5,
    punishShare: 2 / 3,
    detectionChance: 0.5,
    maxFineMultiple: 3,
};

const report = (overrides: Partial<Report> = {}): Report => ({
    tick: 4, P: 1234, collapsed: false,
    invalid: new Map(), charges: new Map(), harvested: new Map(), received: new Map(),
    upkeep: new Map(), dead: new Map(), gifts: [], outcomes: new Map(),
    forum: { proposed: [], votes: [], judgements: [], delegations: [], news: { tick: 4, proposals: [], adopted: null, verdicts: [] }, quota: null, caught: [], fines: new Map() },
    ...overrides,
});

describe("eventsFromReport", () => {
    it('always records the pool, with the exact P and the tick', () => {
        expect(eventsFromReport(report())).toEqual([{ tick: 4, kind: "pool", P: 1234, collapsed: false }]);
    });

    it('turns every part of a report into flat events', () => {
        const events = eventsFromReport(report({
            harvested: new Map([["a", 300]]),
            charges: new Map([["a", 100]]),
            upkeep: new Map([["a", 100]]),
            received: new Map([["b", 50]]),
            invalid: new Map([["b", [{ action: { type: "harvest", amount: 1.5 }, reason: "not whole credits" as const }]]]),
            dead: new Map([["c", "hunger" as const]]),
        }));
        expect(events.map(e => e.kind)).toEqual(["pool", "harvest", "charge", "upkeep", "received", "rejected", "death"]);
        expect(ofKind(events, "death")).toEqual([{ tick: 4, kind: "death", agent: "c", reason: "hunger" }]);
    });

    it('skips zero harvests and zero charges, but keeps zero upkeep', () => {
        const events = eventsFromReport(report({
            harvested: new Map([["a", 0]]),
            charges: new Map([["a", 0]]),
            upkeep: new Map([["a", 0]]), // an agent that could not pay anything: worth knowing
        }));
        expect(events.map(e => e.kind)).toEqual(["pool", "upkeep"]);
    });

    it('orders events by agent id, not by the order agents submitted in', () => {
        const forward = eventsFromReport(report({ harvested: new Map([["a", 1], ["b", 2], ["c", 3]]) }));
        const backward = eventsFromReport(report({ harvested: new Map([["c", 3], ["b", 2], ["a", 1]]) }));
        expect(backward).toEqual(forward);
    });

    it('works on a real report from resolve', () => {
        const state = createWorld(1, ["a", "b"], laws);
        const submissions = new Map<string, WorldAction[]>([["a", [{ type: "harvest", amount: 300 }]]]);
        const { state: next, report: r } = resolve(state, submissions, laws);
        const events = eventsFromReport(r);
        expect(ofKind(events, "pool")).toEqual([{ tick: 0, kind: "pool", P: next.P, collapsed: false }]);
        expect(ofKind(events, "harvest")).toEqual([{ tick: 0, kind: "harvest", agent: "a", gross: 300 }]);
        expect(ofKind(events, "upkeep").map(e => e.agent)).toEqual(["a", "b"]);
    });
});

describe("Ledger actor", () => {
    const setup = () => {
        const system = new Supervisor({ onError: () => {} }, { policy: "escalate" });
        return { system, ledger: spawnLedger(system) };
    };
    const pool = (tick: number): LedgerEvent => ({ tick, kind: "pool", P: 100, collapsed: false });

    it('appends in order and a later read sees every earlier record', async () => {
        const { system, ledger } = setup();
        record(ledger, [pool(0)]);
        record(ledger, [pool(1), pool(2)]);
        expect((await readAll(ledger)).map(e => e.tick)).toEqual([0, 1, 2]);
        system.stop();
    });

    it('a reader cannot change the log', async () => {
        const { system, ledger } = setup();
        record(ledger, [pool(0)]);
        const copy = await readAll(ledger);
        copy.push(pool(99));
        expect(() => { (copy[0] as { P: number }).P = -1; }).toThrow(); // events are frozen
        expect(await readAll(ledger)).toEqual([pool(0)]);
        system.stop();
    });

    it('a writer changing its own event object afterwards does not change the log', async () => {
        const { system, ledger } = setup();
        const event = { tick: 0, kind: "pool" as const, P: 100, collapsed: false };
        record(ledger, [event]);
        event.P = -1;
        expect((await readAll(ledger))[0]).toEqual(pool(0));
        system.stop();
    });
});
