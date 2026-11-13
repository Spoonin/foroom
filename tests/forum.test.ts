// forum.ts: pure functions over votes and delegations, called from World.resolve.
//
//   effectiveVotes(electorate, direct, delegations) → Map<AgentId, V>
//     The vote that counts for each member of the electorate: its own direct vote, else the
//     direct vote of the first member up its delegation chain who voted. Members outside the
//     electorate (the dead, the accused) are passed through: their own votes are ignored, but
//     the chain follows their delegation onward. Cycles end the chain.
//
//   tallyProposals(proposals, votes, electorate, delegations, rules) → { adopted, results }
//     A proposal passes with yes > no and a quorum (yes + no ≥ quorum × electorate). Of those
//     that pass, the most yes votes wins; a tie goes to the lower quota (a number beats null,
//     which lifts the quota), then to the earlier proposal in the list.
//
//   detectViolations(taken, quota, random, rules) → Violation[]
//     Who took more than the quota (gross, what the pool actually gave, not what was asked)
//     and was caught: one random() draw per violator, in id order; caught when random() < chance.
//
//   judgeCase(violation, votes, electorate, delegations, rules) → { punish, spare, fine }
//     A vote is 0 (spare) or k ≥ 1 (fine k × the excess, took − quota: k = 1 gives back what was
//     taken over the quota, k > 1 costs more than the violation gained). The accused does not
//     vote and is not counted. Punished when punish ≥ punishShare × (punish + spare) and the
//     quorum is met; the fine is the smallest k among the punishing votes × the excess.
//     (k above the maxFineMultiple law is rejected by World before it gets here.)

import { describe, expect, it } from "vitest";
import { detectViolations, effectiveVotes, judgeCase, tallyProposals, type Proposal, type Violation } from "../src/world/forum";
import type { AgentId } from "../src/contracts";

const rules = { quorum: 0.5, punishShare: 2 / 3, detectionChance: 0.5 };

const map = <V>(entries: Record<AgentId, V>) => new Map(Object.entries(entries));
const none = new Map<AgentId, AgentId>();

// A random() that returns the given numbers in order, and fails if asked for more.
function draws(...values: number[]) {
    const queue = [...values];
    const random = () => {
        const next = queue.shift();
        if (next === undefined) throw new Error("random() called more often than expected");
        return next;
    };
    return Object.assign(random, { left: () => queue.length });
}

describe("effectiveVotes", () => {
    const electorate = ["a", "b", "c", "d"];

    it("a member's own vote counts for it", () => {
        expect(effectiveVotes(electorate, map({ a: true }), none)).toEqual(map({ a: true }));
    });

    it("a member who delegated gets its delegate's vote", () => {
        expect(effectiveVotes(electorate, map({ b: false }), map({ a: "b" }))).toEqual(map({ a: false, b: false }));
    });

    it("delegation is transitive: a → b → c, and c's vote counts for all three", () => {
        const votes = effectiveVotes(electorate, map({ c: true }), map({ a: "b", b: "c" }));

        expect(votes).toEqual(map({ a: true, b: true, c: true }));
    });

    it("the first voter up the chain wins: a → b → c, b votes yes, c votes no, so a counts yes", () => {
        const votes = effectiveVotes(electorate, map({ b: true, c: false }), map({ a: "b", b: "c" }));

        expect(votes.get("a")).toBe(true);
    });

    it("a direct vote overrides the voter's own delegation", () => {
        const votes = effectiveVotes(electorate, map({ a: false, b: true }), map({ a: "b" }));

        expect(votes.get("a")).toBe(false);
    });

    it("a chain that reaches no voter gives no vote", () => {
        const votes = effectiveVotes(electorate, map({ d: true }), map({ a: "b", b: "c" }));

        expect(votes.has("a")).toBe(false);
        expect(votes.has("b")).toBe(false);
    });

    it("a cycle with no voter in it gives no vote, and terminates", () => {
        const votes = effectiveVotes(electorate, new Map(), map({ a: "b", b: "c", c: "a" }));

        expect(votes.size).toBe(0);
    });

    it("a cycle with a voter in it gives that voter's vote to the others in the cycle", () => {
        const votes = effectiveVotes(electorate, map({ c: true }), map({ a: "b", b: "c", c: "a" }));

        expect(votes).toEqual(map({ a: true, b: true, c: true }));
    });

    it("a member outside the electorate is passed through: a → x → c gives a c's vote, and x gets nothing", () => {
        const votes = effectiveVotes(electorate, map({ x: false, c: true }), map({ a: "x", x: "c" }));

        expect(votes.get("a")).toBe(true);
        expect(votes.has("x")).toBe(false);
    });

    it("a delegation to oneself counts as no delegation", () => {
        expect(effectiveVotes(electorate, new Map(), map({ a: "a" })).has("a")).toBe(false);
    });

    it("works for any vote type, not only yes/no", () => {
        expect(effectiveVotes(electorate, map({ b: 3 }), map({ a: "b" }))).toEqual(map({ a: 3, b: 3 }));
    });
});

describe("tallyProposals", () => {
    const electorate = ["a", "b", "c", "d"];
    const p = (id: string, perAgent: number | null): Proposal => ({ id, by: "a", tick: 1, perAgent });
    // proposalId → voter → yes/no
    const ballots = (entries: Record<string, Record<AgentId, boolean>>) =>
        new Map(Object.entries(entries).map(([id, votes]) => [id, map(votes)]));

    it("yes > no with a quorum adopts the proposal", () => {
        const proposal = p("p-1-0", 700);
        const { adopted } = tallyProposals([proposal], ballots({ "p-1-0": { a: true, b: true, c: false } }), electorate, none, rules);

        expect(adopted).toEqual(proposal);
    });

    it("reports yes, no and whether it passed, for every proposal in the given order", () => {
        const { results } = tallyProposals(
            [p("p-1-0", 700), p("p-1-1", 500)],
            ballots({ "p-1-0": { a: true, b: false }, "p-1-1": { c: true } }),
            electorate, none, rules,
        );

        expect(results).toEqual([
            { id: "p-1-0", yes: 1, no: 1, passed: false },
            { id: "p-1-1", yes: 1, no: 0, passed: false }, // 1 of 4 voted: no quorum
        ]);
    });

    it("a tie does not pass", () => {
        const { adopted } = tallyProposals([p("p-1-0", 700)], ballots({ "p-1-0": { a: true, b: true, c: false, d: false } }), electorate, none, rules);

        expect(adopted).toBeNull();
    });

    it("exactly the quorum is enough: 2 of 4 voting yes passes", () => {
        const { adopted } = tallyProposals([p("p-1-0", 700)], ballots({ "p-1-0": { a: true, b: true } }), electorate, none, rules);

        expect(adopted?.id).toBe("p-1-0");
    });

    it("below the quorum nothing passes, however one-sided", () => {
        const { adopted } = tallyProposals([p("p-1-0", 700)], ballots({ "p-1-0": { a: true } }), electorate, none, rules);

        expect(adopted).toBeNull();
    });

    it("delegated votes count toward both the result and the quorum", () => {
        const { results } = tallyProposals(
            [p("p-1-0", 700)], ballots({ "p-1-0": { a: true, d: false } }), electorate, map({ b: "a", c: "a" }), rules,
        );

        expect(results[0]).toEqual({ id: "p-1-0", yes: 3, no: 1, passed: true });
    });

    it("of several that pass, the one with the most yes votes wins", () => {
        const { adopted } = tallyProposals(
            [p("p-1-0", 700), p("p-1-1", 900)],
            ballots({ "p-1-0": { a: true, b: true }, "p-1-1": { a: true, b: true, c: true } }),
            electorate, none, rules,
        );

        expect(adopted?.id).toBe("p-1-1");
    });

    it("equal yes votes: the lower quota wins, and any quota beats lifting it", () => {
        const votes = { a: true, b: true, c: true };
        const { adopted } = tallyProposals(
            [p("lift", null), p("high", 900), p("low", 500)],
            ballots({ lift: votes, high: votes, low: votes }),
            electorate, none, rules,
        );

        expect(adopted?.id).toBe("low");
    });

    it("equal yes votes and equal quotas: the earlier proposal wins", () => {
        const votes = { a: true, b: true };
        const { adopted } = tallyProposals(
            [p("first", 500), p("second", 500)], ballots({ first: votes, second: votes }), electorate, none, rules,
        );

        expect(adopted?.id).toBe("first");
    });

    it("a proposal nobody voted on is reported with zeros and does not pass", () => {
        const { results, adopted } = tallyProposals([p("p-1-0", 700)], new Map(), electorate, none, rules);

        expect(results).toEqual([{ id: "p-1-0", yes: 0, no: 0, passed: false }]);
        expect(adopted).toBeNull();
    });

    it("no proposals: nothing adopted, no results", () => {
        expect(tallyProposals([], new Map(), electorate, none, rules)).toEqual({ adopted: null, results: [] });
    });
});

describe("detectViolations", () => {
    it("without a quota nobody violates anything, and no randomness is used", () => {
        const random = draws();
        expect(detectViolations(map({ a: 5_000 }), null, random, rules)).toEqual([]);
    });

    it("taking exactly the quota, or less, is not a violation and draws nothing", () => {
        const random = draws();
        expect(detectViolations(map({ a: 700, b: 300 }), 700, random, rules)).toEqual([]);
    });

    it("a violator is caught when the draw is below the detection chance", () => {
        expect(detectViolations(map({ a: 900 }), 700, draws(0.49), rules)).toEqual([{ agent: "a", took: 900, quota: 700 }]);
        expect(detectViolations(map({ a: 900 }), 700, draws(0.5), rules)).toEqual([]);
    });

    it("one draw per violator, in id order, whatever order the harvests came in", () => {
        // a draws 0.9 (missed), c draws 0.1 (caught); b is under the quota and draws nothing.
        const random = draws(0.9, 0.1);
        const caught = detectViolations(map({ c: 800, b: 100, a: 800 }), 700, random, rules);

        expect(caught.map(v => v.agent)).toEqual(["c"]);
        expect(random.left()).toBe(0);
    });

    it("a chance of 1 catches every violator, a chance of 0 none", () => {
        const taken = map({ a: 800, b: 900 });
        expect(detectViolations(taken, 700, draws(0.99, 0.99), { detectionChance: 1 })).toHaveLength(2);
        expect(detectViolations(taken, 700, draws(0, 0), { detectionChance: 0 })).toEqual([]);
    });

    it("the result is in id order", () => {
        const caught = detectViolations(map({ c: 800, a: 800 }), 700, draws(0, 0), rules);

        expect(caught.map(v => v.agent)).toEqual(["a", "c"]);
    });
});

describe("judgeCase", () => {
    // Four judges and the accused, v, who took 900 against a quota of 700: an excess of 200.
    const electorate = ["a", "b", "c", "d", "v"];
    const case_: Violation = { agent: "v", took: 900, quota: 700 };

    it("punished: the fine is the smallest punishing vote × the excess", () => {
        expect(judgeCase(case_, map({ a: 3, b: 1, c: 2 }), electorate, none, rules)).toEqual({ punish: 3, spare: 0, fine: 200 });
    });

    it("the fine grows with the excess, so taking more costs more", () => {
        const big: Violation = { agent: "v", took: 5_700, quota: 700 };
        expect(judgeCase(big, map({ a: 3, b: 3, c: 3 }), electorate, none, rules).fine).toBe(15_000);
    });

    it("exactly two thirds punishing is enough", () => {
        expect(judgeCase(case_, map({ a: 2, b: 2, c: 0 }), electorate, none, rules)).toEqual({ punish: 2, spare: 1, fine: 400 });
    });

    it("less than two thirds: spared, no fine", () => {
        expect(judgeCase(case_, map({ a: 1, b: 0 }), electorate, none, rules)).toEqual({ punish: 1, spare: 1, fine: 0 });
    });

    it("below the quorum: no fine, however one-sided", () => {
        // 1 of the 4 judges voted; the quorum is 2.
        expect(judgeCase(case_, map({ a: 3 }), electorate, none, rules).fine).toBe(0);
    });

    it("the accused does not vote and does not count toward the quorum", () => {
        // a and b are 2 of 4 judges: the quorum is met without v, and v's "spare" is ignored.
        expect(judgeCase(case_, map({ a: 1, b: 1, v: 0 }), electorate, none, rules)).toEqual({ punish: 2, spare: 0, fine: 200 });
    });

    it("a delegation through the accused passes on: a → v → b gives a b's vote", () => {
        expect(judgeCase(case_, map({ b: 2, c: 2 }), electorate, map({ a: "v", v: "b" }), rules)).toEqual({ punish: 3, spare: 0, fine: 400 });
    });

    it("a judge carries the votes delegated to it: a decides for b, c and d", () => {
        expect(judgeCase(case_, map({ a: 3 }), electorate, map({ b: "a", c: "a", d: "a" }), rules)).toEqual({ punish: 4, spare: 0, fine: 600 });
    });

    it("a judge who spares, with delegated weight, can outvote the punishers", () => {
        expect(judgeCase(case_, map({ a: 0, b: 3 }), electorate, map({ c: "a", d: "a" }), rules)).toEqual({ punish: 1, spare: 3, fine: 0 });
    });

    it("nobody voted: spared", () => {
        expect(judgeCase(case_, new Map(), electorate, none, rules)).toEqual({ punish: 0, spare: 0, fine: 0 });
    });
});
