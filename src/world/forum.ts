// forum.ts — see STEPS.md, step 4 ("Forum rules").
//
// Pure functions, not an actor: World.resolve calls them, so an adopted quota and a verdict take
// effect inside the same atomic resolve. Nothing here knows about balances, prices or the pool;
// World charges, fines and records.
//
// - effectiveVotes: who votes for whom, through transitive delegation. Shared by proposals and cases.
// - tallyProposals: which quota proposal, if any, is adopted.
// - detectViolations: who took more than the quota and was caught.
// - judgeCase: the verdict on one caught violator.

import type { AgentId, ForumState, Laws, Proposal } from "../contracts";

export type { Proposal };

export interface ProposalResult {
    id: string;
    yes: number; // weighted: each vote counts for its voter and everyone who delegated to it
    no: number;
    passed: boolean;
}

export interface Violation {
    agent: AgentId;
    took: number; // gross: what the pool actually gave
    quota: number;
}

export interface Verdict {
    punish: number; // weighted votes for a fine
    spare: number; // weighted votes for no fine
    fine: number; // 0 unless punished
}

// The vote that counts for each member of the electorate: its own direct vote, else the direct
// vote of the first member up its delegation chain who voted.
// - Agents outside the electorate (the dead, the accused) are passed through: their own votes
//   are ignored, the chain follows their delegation onward.
// - A chain that comes back on itself, or delegates to itself, ends without a vote.
export function effectiveVotes<V>(
    electorate: readonly AgentId[],
    direct: ReadonlyMap<AgentId, V>,
    delegations: ReadonlyMap<AgentId, AgentId>,
): Map<AgentId, V> {
    const members = new Set(electorate);
    const result = new Map<AgentId, V>();
    for (const member of electorate) {
        const seen = new Set<AgentId>();
        let current: AgentId | undefined = member;
        while (current !== undefined && !seen.has(current)) {
            if (members.has(current) && direct.has(current)) {
                result.set(member, direct.get(current) as V);
                break;
            }
            seen.add(current);
            current = delegations.get(current);
        }
    }
    return result;
}

// Weighted yes/no for every proposal, in the given order, and the one adopted: of those that
// pass (yes > no, and yes + no reach the quorum), the most yes; then the lower quota (any quota
// beats lifting it); then the earlier proposal.
export function tallyProposals(
    proposals: readonly Proposal[],
    votes: ReadonlyMap<string, ReadonlyMap<AgentId, boolean>>,
    electorate: readonly AgentId[],
    delegations: ReadonlyMap<AgentId, AgentId>,
    rules: Pick<Laws, "quorum">,
): { adopted: Proposal | null; results: ProposalResult[] } {
    const results = proposals.map((proposal): ProposalResult => {
        const counted = [...effectiveVotes(electorate, votes.get(proposal.id) ?? new Map(), delegations).values()];
        const yes = counted.filter(vote => vote).length;
        const no = counted.length - yes;
        return { id: proposal.id, yes, no, passed: yes > no && reachesQuorum(yes + no, electorate.length, rules) };
    });

    const quotaRank = (p: Proposal) => p.perAgent ?? Infinity;
    const winner = proposals
        .map((proposal, index) => ({ proposal, index, result: results[index]! }))
        .filter(({ result }) => result.passed)
        .sort((a, b) => b.result.yes - a.result.yes || quotaRank(a.proposal) - quotaRank(b.proposal) || a.index - b.index)[0];

    return { adopted: winner?.proposal ?? null, results };
}

// The violators who were caught, in id order. One random() draw per violator, in id order, so a
// seeded run catches the same agents whatever order the harvests arrived in.
export function detectViolations(
    taken: ReadonlyMap<AgentId, number>,
    quota: number | null,
    random: () => number,
    rules: Pick<Laws, "detectionChance">,
): Violation[] {
    if (quota === null) return [];
    const caught: Violation[] = [];
    for (const agent of [...taken.keys()].sort(compareIds)) {
        const took = taken.get(agent)!;
        if (took > quota && random() < rules.detectionChance) caught.push({ agent, took, quota });
    }
    return caught;
}

// The verdict on one case. A vote is 0 (spare) or k ≥ 1 (a fine of k × the excess). The accused
// neither votes nor counts toward the quorum. Punished when punish ≥ punishShare of the votes
// cast and the quorum is met; the fine is the smallest punishing k × the excess.
export function judgeCase(
    violation: Violation,
    votes: ReadonlyMap<AgentId, number>,
    electorate: readonly AgentId[],
    delegations: ReadonlyMap<AgentId, AgentId>,
    rules: Pick<Laws, "quorum" | "punishShare">,
): Verdict {
    const judges = electorate.filter(id => id !== violation.agent);
    const counted = [...effectiveVotes(judges, votes, delegations).values()];
    const fines = counted.filter(k => k > 0);
    const punish = fines.length;
    const spare = counted.length - punish;
    const cast = punish + spare;

    const punished = cast > 0 && reachesQuorum(cast, judges.length, rules) && punish / cast >= rules.punishShare;
    const fine = punished ? Math.min(...fines) * (violation.took - violation.quota) : 0;
    return { punish, spare, fine };
}

// Ratios, not products: 2 of 4 against a quorum of 0.5 is exactly 0.5, with no float drift.
const reachesQuorum = (cast: number, electorate: number, rules: Pick<Laws, "quorum">): boolean =>
    electorate > 0 && cast / electorate >= rules.quorum;

export function emptyForum(): ForumState {
    return { quota: null, proposals: [], cases: [], delegations: new Map() };
}

const compareIds = (a: AgentId, b: AgentId): number => (a < b ? -1 : a > b ? 1 : 0);
