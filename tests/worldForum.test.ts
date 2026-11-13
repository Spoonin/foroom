// The forum inside World.resolve: timing, validation, detection, verdicts and fines.
// The vote arithmetic itself is tested in forum.test.ts; this is about how World uses it.

import { describe, expect, it } from "vitest";
import { createWorld, observe, resolve } from "../src/world/world";
import { eventsFromReport, ofKind } from "../src/world/ledger";
import { laws as configLaws } from "../src/config";
import type { AgentId, Case, Laws, WorldAction, WorldState } from "../src/contracts";

const laws: Laws = { ...structuredClone(configLaws) as Laws, detectionChance: 1 }; // every violator caught
const lawsWith = (changes: Partial<Laws>): Laws => ({ ...laws, ...changes });

const world = (ids: AgentId[], start: { P?: number; balance?: number } = {}): WorldState =>
    createWorld(1, ids, laws, { P: 50_000, balance: 2_000, ...start });
const subs = (m: Record<AgentId, WorldAction[]>) => new Map(Object.entries(m));
const harvest = (amount: number): WorldAction => ({ type: "harvest", amount });
const propose = (perAgent: number | null): WorldAction => ({ type: "propose", rule: { kind: "quota", perAgent } });
const vote = (proposalId: string, yes = true): WorldAction => ({ type: "vote", proposalId, yes });
const judge = (caseId: string, fine: number): WorldAction => ({ type: "judge", caseId, fine });

// A world with one listed case: a took 800 against a quota of 500 on tick 0.
const accused: Case = { id: "c-0-a", agent: "a", tick: 0, took: 800, quota: 500 };
function withCase(start: { P?: number; balance?: number } = {}): WorldState {
    const state = world(["a", "b", "c", "d"], start);
    state.tick = 1;
    state.forum.quota = 500;
    state.forum.cases = [accused];
    return state;
}

describe("proposals: proposed on t, voted on t+1, in force from t+2", () => {
    it("a proposal is charged, gets an id from World, and is open on the next tick", () => {
        const { state, report } = resolve(world(["a", "b"]), subs({ a: [propose(500)] }), laws);

        expect(report.charges.get("a")).toBe(laws.prices.propose);
        expect(state.forum.proposals).toEqual([{ id: "p-0-0", by: "a", tick: 0, perAgent: 500 }]);
        expect(observe(state, laws).get("b")!.forum.proposals.map(p => p.id)).toEqual(["p-0-0"]);
    });

    it("ids follow agent id order, not submit order", () => {
        const { state } = resolve(world(["a", "b"]), new Map([["b", [propose(700)]], ["a", [propose(500)]]]), laws);

        expect(state.forum.proposals.map(p => [p.id, p.by])).toEqual([["p-0-0", "a"], ["p-0-1", "b"]]);
    });

    it("an adopted quota does not catch harvests on the tick it is adopted, only from the next one", () => {
        const t0 = resolve(world(["a", "b"]), subs({ a: [propose(500)] }), laws).state;

        const t1 = resolve(t0, subs({ a: [vote("p-0-0"), harvest(800)], b: [vote("p-0-0")] }), laws);
        expect(t1.state.forum.quota).toBe(500);
        expect(t1.report.forum.news.adopted?.id).toBe("p-0-0");
        expect(t1.state.forum.cases).toEqual([]); // the quota was not in force yet

        const t2 = resolve(t1.state, subs({ a: [harvest(800)] }), laws);
        expect(t2.state.forum.cases.map(c => c.id)).toEqual(["c-2-a"]);
    });

    it("a proposal is voted on once: on the tick after, it is gone whether it passed or not", () => {
        const t0 = resolve(world(["a", "b"]), subs({ a: [propose(500)] }), laws).state;
        const t1 = resolve(t0, subs({}), laws).state; // nobody voted: no quorum

        expect(t1.forum.quota).toBeNull();
        expect(t1.forum.proposals).toEqual([]);
        expect(t1.news?.proposals).toEqual([{ id: "p-0-0", by: "a", tick: 0, perAgent: 500, yes: 0, no: 0, passed: false }]);
    });

    it("an adopted null lifts the quota", () => {
        const start = world(["a", "b"]);
        start.forum.quota = 500;
        start.forum.proposals = [{ id: "p-0-0", by: "a", tick: 0, perAgent: null }];

        expect(resolve(start, subs({ a: [vote("p-0-0")], b: [vote("p-0-0")] }), laws).state.forum.quota).toBeNull();
    });

    it("a delegation made this tick counts in this tick's votes", () => {
        const start = world(["a", "b", "c", "d"]);
        start.forum.proposals = [{ id: "p-0-0", by: "a", tick: 0, perAgent: 500 }];
        // b alone is 1 of 4, below the quorum; with a's delegation it is 2 of 4.
        const { report } = resolve(start, subs({ a: [{ type: "delegate", to: "b" }], b: [vote("p-0-0")] }), laws);

        expect(report.forum.news.proposals[0]).toMatchObject({ yes: 2, no: 0, passed: true });
    });
});

describe("validation of forum actions", () => {
    function reasons(state: WorldState, actions: WorldAction[]) {
        return resolve(state, subs({ b: actions }), laws).report.invalid.get("b")?.map(i => i.reason);
    }

    it("a vote on a proposal that is not open is rejected", () => {
        expect(reasons(world(["a", "b"]), [vote("p-9-9")])).toEqual(["unknown proposal"]);
    });

    it("a second vote on the same proposal is a duplicate", () => {
        const start = world(["a", "b"]);
        start.forum.proposals = [{ id: "p-0-0", by: "a", tick: 0, perAgent: 500 }];
        expect(reasons(start, [vote("p-0-0"), vote("p-0-0", false)])).toEqual(["duplicate"]);
    });

    it("a case vote: unknown case, own case, fine above the limit, duplicate", () => {
        expect(reasons(withCase(), [judge("c-7-x", 1)])).toEqual(["unknown case"]);
        expect(reasons(withCase(), [judge("c-0-a", laws.maxFineMultiple + 1)])).toEqual(["fine out of range"]);
        expect(reasons(withCase(), [judge("c-0-a", 1), judge("c-0-a", 2)])).toEqual(["duplicate"]);

        const own = resolve(withCase(), subs({ a: [judge("c-0-a", 0)] }), laws).report.invalid.get("a");
        expect(own?.map(i => i.reason)).toEqual(["own case"]);
    });

    it("a delegation: to oneself, to someone not alive, twice in one tick", () => {
        expect(reasons(world(["a", "b"]), [{ type: "delegate", to: "b" }])).toEqual(["to self"]);
        expect(reasons(world(["a", "b"]), [{ type: "delegate", to: "ghost" }])).toEqual(["not alive"]);
        expect(reasons(world(["a", "b"]), [{ type: "delegate", to: "a" }, { type: "delegate", to: null }])).toEqual(["duplicate"]);
    });

    it("a case vote costs the judge price; a proposal vote costs the vote price", () => {
        const start = withCase();
        start.forum.proposals = [{ id: "p-0-0", by: "a", tick: 0, perAgent: 500 }];
        const { report } = resolve(start, subs({ b: [judge("c-0-a", 1), vote("p-0-0")] }), laws);

        expect(report.charges.get("b")).toBe(laws.prices.judge + laws.prices.vote);
    });
});

describe("detection", () => {
    function quota500(chance: number) {
        const start = world(["a", "b"]);
        start.forum.quota = 500;
        return resolve(start, subs({ a: [harvest(800)], b: [harvest(500)] }), lawsWith({ detectionChance: chance }));
    }

    it("taking more than the quota is not stopped: the harvest goes through in full", () => {
        expect(quota500(1).report.harvested.get("a")).toBe(800);
    });

    it("a caught violator gets a case on the public list, and is told in its outcome", () => {
        const { state, report } = quota500(1);

        expect(state.forum.cases).toEqual([{ id: "c-0-a", agent: "a", tick: 0, took: 800, quota: 500 }]);
        expect(report.outcomes.get("a")?.caught).toEqual({ took: 800, quota: 500 });
        expect(report.outcomes.get("b")?.caught).toBeUndefined(); // exactly the quota is fine
        expect(observe(state, laws).get("b")!.forum.cases.map(c => c.agent)).toEqual(["a"]);
    });

    it("a violator who is not caught leaves no trace an agent can see", () => {
        const { state, report } = quota500(0);

        expect(state.forum.cases).toEqual([]);
        expect(report.outcomes.get("a")?.caught).toBeUndefined();
    });

    it("the same seed catches the same violators", () => {
        const run = () => {
            const start = world(["a", "b", "c", "d"]);
            start.forum.quota = 100;
            const taken = subs({ a: [harvest(500)], b: [harvest(500)], c: [harvest(500)], d: [harvest(500)] });
            return resolve(start, taken, lawsWith({ detectionChance: 0.5 })).state.forum.cases.map(c => c.agent);
        };
        expect(run()).toEqual(run());
    });
});

describe("verdicts and fines", () => {
    it("punished: the fine is taken after upkeep, the case closes, and everyone sees the verdict", () => {
        // b asks 2, c asks 3: the smallest is 2 × the excess of 300.
        const { state, report } = resolve(withCase(), subs({ b: [judge("c-0-a", 2)], c: [judge("c-0-a", 3)] }), laws);

        expect(report.forum.fines.get("a")).toBe(600);
        expect(state.agents.get("a")?.balance).toBe(2_000 - laws.upkeep - 600);
        expect(report.outcomes.get("a")?.fines).toEqual([{ caseId: "c-0-a", due: 600, paid: 600 }]);
        expect(state.forum.cases).toEqual([]);
        expect(observe(state, laws).get("d")!.forum.news?.verdicts).toEqual([
            { caseId: "c-0-a", agent: "a", punish: 2, spare: 0, fine: 600, paid: 600 },
        ]);
    });

    it("the fine goes back to the pool", () => {
        const start = withCase({ P: 1_000 });
        start.collapsed = true; // no regrowth, so the pool moves by exactly the fine
        const { state } = resolve(start, subs({ b: [judge("c-0-a", 1)], c: [judge("c-0-a", 1)] }), laws);

        expect(state.P).toBe(1_300);
    });

    it("a fine larger than the balance takes it down to 0, the rest is forgiven, and the case closes", () => {
        const { state, report } = resolve(withCase({ balance: 400 }), subs({ b: [judge("c-0-a", 3)], c: [judge("c-0-a", 3)] }), laws);

        expect(report.outcomes.get("a")?.fines).toEqual([{ caseId: "c-0-a", due: 900, paid: 300 }]);
        expect(state.agents.get("a")?.balance).toBe(0);
        expect(state.agents.get("a")?.hungerTicks).toBe(0); // upkeep came first and was paid in full
        expect(state.forum.cases).toEqual([]);
    });

    it("spared, or no quorum: the case stays open, to be judged again next tick", () => {
        const spared = resolve(withCase(), subs({ b: [judge("c-0-a", 0)], c: [judge("c-0-a", 0)] }), laws);
        expect(spared.state.forum.cases).toEqual([accused]);
        expect(spared.report.forum.news.verdicts[0]).toMatchObject({ punish: 0, spare: 2, fine: 0 });

        const noQuorum = resolve(withCase(), subs({ b: [judge("c-0-a", 3)] }), laws);
        expect(noQuorum.state.forum.cases).toEqual([accused]);
    });

    it("an accused who dies closes the case", () => {
        const start = withCase({ balance: 0 });
        start.agents.set("a", { age: 1, balance: 0, hungerTicks: laws.starvationTicks - 1 });
        const { state, report } = resolve(start, subs({}), laws);

        expect(report.dead.get("a")).toBe("hunger");
        expect(state.forum.cases).toEqual([]);
    });
});

describe("what agents see of the forum", () => {
    it("each agent sees its own delegation, never anyone else's", () => {
        const { state } = resolve(world(["a", "b", "c"]), subs({ a: [{ type: "delegate", to: "b" }] }), laws);
        const views = observe(state, laws);

        expect(views.get("a")!.forum.myDelegate).toBe("b");
        expect(views.get("b")!.forum.myDelegate).toBeNull();
        expect(JSON.stringify(views.get("c")!.forum)).not.toContain('"b"');
    });

    it("a revoked delegation is gone", () => {
        const t0 = resolve(world(["a", "b"]), subs({ a: [{ type: "delegate", to: "b" }] }), laws).state;
        const t1 = resolve(t0, subs({ a: [{ type: "delegate", to: null }] }), laws).state;

        expect(observe(t1, laws).get("a")!.forum.myDelegate).toBeNull();
    });

    it("the forum in an observation is a copy: a policy that changes it changes nothing else", () => {
        const state = withCase();
        const view = observe(state, laws).get("b")!;
        view.forum.cases.pop();

        expect(state.forum.cases).toEqual([accused]);
        expect(observe(state, laws).get("c")!.forum.cases).toEqual([accused]);
    });
});

describe("the forum in the Ledger", () => {
    it("records votes, the tally, the adoption, verdicts and new cases", () => {
        const start = withCase();
        start.forum.proposals = [{ id: "p-0-0", by: "b", tick: 0, perAgent: 400 }];
        const actions = subs({
            a: [harvest(900)], // over the quota in force (500): caught
            b: [vote("p-0-0"), judge("c-0-a", 1)],
            c: [vote("p-0-0"), judge("c-0-a", 1), { type: "delegate", to: "b" }],
        });
        const events = eventsFromReport(resolve(start, actions, laws).report);

        expect(ofKind(events, "voted").map(e => e.agent)).toEqual(["b", "c"]);
        expect(ofKind(events, "judged").map(e => [e.agent, e.fine])).toEqual([["b", 1], ["c", 1]]);
        expect(ofKind(events, "delegated")).toEqual([{ tick: 1, kind: "delegated", agent: "c", to: "b" }]);
        expect(ofKind(events, "tallied")).toEqual([{ tick: 1, kind: "tallied", proposalId: "p-0-0", yes: 2, no: 0, passed: true }]);
        expect(ofKind(events, "adopted")).toEqual([{ tick: 1, kind: "adopted", proposalId: "p-0-0", perAgent: 400 }]);
        expect(ofKind(events, "verdict")).toEqual([
            { tick: 1, kind: "verdict", agent: "a", caseId: "c-0-a", punish: 2, spare: 0, fine: 300, paid: 300 },
        ]);
        expect(ofKind(events, "caught")).toEqual([{ tick: 1, kind: "caught", agent: "a", caseId: "c-1-a", took: 900, quota: 500 }]);
    });
});
