// world.ts — see STEPS.md, step 2 (forum — step 4, births — step 6).
//
// One tick of resolve, in order:
//   1. validate every action against the state at the start of the tick; charge prices and gifts
//   2. forum, before harvest: delegations change → proposals are tallied (an adopted quota is in
//      force from the next tick) → open cases are judged → this tick's proposals open
//   3. harvest; who took more than the quota in force is caught with laws.detectionChance
//   4. per agent: charges → income → upkeep → fines (after upkeep, down to 0 at most) → hunger → age
//   5. fines go to the pool; collapse check; regrowth

import type { ServerRef, Supervisor } from "@cue/core";
import { type Harvest, AgentId, type Laws, type WorldAction, type WorldState, type AgentState, type Report, type InvalidReason, type DeathReason, type Observation, type Outcome, type Case, type ForumNews, type ForumReport, type ForumState, type Proposal } from "../contracts";
import { deriveSeed, rng, rngNormal } from "../rng";
import { detectViolations, emptyForum, judgeCase, tallyProposals } from "./forum";

// Pure world functions (regrow, allocate, resolve) + a thin World actor on top of them.
// Credits are integers, so growth is floored. With K in the hundreds of thousands, growth near the
// collapse threshold is still hundreds of credits per tick, so flooring never stalls a live pool.
export function regrow(P: number, collapsed: boolean, growLaws: { r: number; K: number }): number {
    return collapsed ? P : P + Math.floor(growLaws.r * P * (1 - P / growLaws.K));
}


interface AllocationResult { allocated: Map<AgentId, number>; remaining: number }

// Splits the harvestable part of the pool between the demands.
// - Harvestable = P · maxHarvestFraction: the law caps the total taken in one tick.
// - Total demand within that cap: everyone gets exactly what they asked for.
// - Over the cap: everyone gets a share of the harvestable amount proportional to their demand.
// Shares are floored to whole credits; the leftover (at most 1 credit per agent) stays in the pool.
export function allocate(
    P: number,
    demands: readonly { id: AgentId; amount: number }[],
    harvestLaws: { maxHarvestFraction: number },
): AllocationResult {
    if (P < 0) {
        throw new Error("Pool must be non-negative");
    }
    if (demands.some(d => d.amount < 0)) {
        throw new Error("Demands must be non-negative");
    }
    if (new Set(demands.map(d => d.id)).size !== demands.length) {
        throw new Error("Duplicate agent id in demands");
    }

    // Float sums depend on order: sort by id so the result does not depend on submit order.
    const sorted = [...demands].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const harvestable = Math.floor(P * harvestLaws.maxHarvestFraction);
    const totalDemand = sorted.reduce((sum, d) => sum + d.amount, 0);
    // totalDemand = 0 always lands here, so the division below never divides by zero.
    const scale = totalDemand <= harvestable ? 1 : harvestable / totalDemand;

    const allocated = new Map<AgentId, number>();
    let totalAllocated = 0;
    for (const d of sorted) {
        const share = Math.floor(d.amount * scale);
        allocated.set(d.id, share);
        totalAllocated += share;
    }

    // Clamp: float rounding must never leave the pool slightly negative.
    const remaining = Math.max(0, P - totalAllocated);
    return { allocated, remaining };
}

type Invalid = Map<AgentId, {action: WorldAction, reason: InvalidReason}[]>;

interface ValidationResult{
    valid: Map<AgentId, WorldAction[]>;
    invalid: Invalid;
}

function upsert(map: Invalid, id: AgentId, action: WorldAction, reason: InvalidReason) {
    if (!map.has(id)) {
        map.set(id, []);
    }
    map.get(id)!.push({ action, reason });
}

// Every credit amount an action carries.
function creditAmounts(action: WorldAction): number[] {
    switch (action.type) {
        case "harvest":
        case "gift":
            return [action.amount];
        case "spawn":
            return [action.endowment];
        case "propose":
            return action.rule.perAgent === null ? [] : [action.rule.perAgent];
        case "judge":
            return [action.fine];
        default:
            return [];
    }
}

function validate(state: WorldState, submissions: Map<AgentId, WorldAction[]>, laws: Laws):ValidationResult  {
    const valid = new Map<AgentId, WorldAction[]>();
    const invalid: Invalid = new Map();
    for (const [id, actions] of submissions) {
        const agent = state.agents.get(id);
        if (!agent) {
            // Agent does not exist in the world state.
            invalid.set(id, actions.map(action => ({ action, reason: "dead" })));
            continue;
        }

        // Paid actions are checked against what is left after the ones already accepted,
        // so several actions together can never cost more than the balance.
        let available = agent.balance;
        let hasHarvest = false;
        let hasDelegate = false;
        const votedOn = new Set<string>(); // proposal and case ids this agent already voted on

        for (const action of actions) {
            // Rule-based policies do not go through zod, so check credit amounts here too.
            // Number.isInteger is false for NaN, ±Infinity and fractions alike: one NaN must
            // never reach allocate, where it would poison the pool and every agent's balance.
            if (creditAmounts(action).some(amount => !Number.isInteger(amount))) {
                upsert(invalid, id, action, "not whole credits");
                continue;
            }
            if((action.type === "gift" || action.type === "harvest") && action.amount < 0) {
                upsert(invalid, id, action, "negative amount");
                continue;
            }
            if (action.type === "gift" && !state.agents.has(action.to)) {
                upsert(invalid, id, action, "unknown recipient");
                continue;
            }
            const forumProblem = forumCheck(state, id, action, laws, votedOn, hasDelegate);
            if (forumProblem) {
                upsert(invalid, id, action, forumProblem);
                continue;
            }
            if (action.type === "harvest") {
                // Harvest is never rejected for lack of funds: its fee is taken from the yield
                // (see netHarvest), so a broke agent can still feed itself.
                if (hasHarvest) {
                    upsert(invalid, id, action, "duplicate");
                    continue;
                }
                hasHarvest = true;
            } else {
                const cost = laws.prices[action.type] + (action.type === "gift" ? action.amount : 0);
                if (available < cost) {
                    upsert(invalid, id, action, "insufficient funds");
                    continue;
                }
                available -= cost;
            }

            // If we reach here, the action is valid.
            if (action.type === "vote") votedOn.add(action.proposalId);
            if (action.type === "judge") votedOn.add(action.caseId);
            if (action.type === "delegate") hasDelegate = true;
            if (!valid.has(id)) {
                valid.set(id, []);
            }
            valid.get(id)!.push(action);
        }
    }

    return { valid, invalid };
}

// Forum actions are checked against the forum at the start of the tick: a vote only on a proposal
// that is open now, a case vote only on a listed case (not one's own), one vote per proposal or
// case, one delegation change per tick, to a living agent other than oneself.
function forumCheck(
    state: WorldState, id: AgentId, action: WorldAction, laws: Laws, votedOn: ReadonlySet<string>, hasDelegate: boolean,
): InvalidReason | null {
    switch (action.type) {
        case "vote":
            if (!state.forum.proposals.some(p => p.id === action.proposalId)) return "unknown proposal";
            return votedOn.has(action.proposalId) ? "duplicate" : null;
        case "judge": {
            const open = state.forum.cases.find(c => c.id === action.caseId);
            if (!open) return "unknown case";
            if (open.agent === id) return "own case";
            if (action.fine > laws.maxFineMultiple) return "fine out of range";
            return votedOn.has(action.caseId) ? "duplicate" : null;
        }
        case "delegate":
            if (hasDelegate) return "duplicate";
            if (action.to === id) return "to self";
            return action.to !== null && !state.agents.has(action.to) ? "not alive" : null;
        default:
            return null;
    }
}

// The forum's part of a tick before harvest (see the order at the top of this file): this tick's
// delegation changes apply first, so they count in this tick's votes; then the proposals opened
// last tick are tallied, and the listed cases judged. The electorate is everyone alive at the
// start of the tick.
function forumBeforeHarvest(state: WorldState, valid: Map<AgentId, WorldAction[]>, laws: Laws) {
    const delegations = new Map(state.forum.delegations);
    const votes = new Map<string, Map<AgentId, boolean>>();
    const judgements = new Map<string, Map<AgentId, number>>();
    const proposed: Proposal[] = [];
    const report: Pick<ForumReport, "votes" | "judgements" | "delegations"> = { votes: [], judgements: [], delegations: [] };

    for (const id of [...valid.keys()].sort(compareIds)) {
        for (const action of valid.get(id)!) {
            switch (action.type) {
                case "delegate":
                    if (action.to === null) delegations.delete(id);
                    else delegations.set(id, action.to);
                    report.delegations.push({ agent: id, to: action.to });
                    break;
                case "vote":
                    if (!votes.has(action.proposalId)) votes.set(action.proposalId, new Map());
                    votes.get(action.proposalId)!.set(id, action.yes);
                    report.votes.push({ agent: id, proposalId: action.proposalId, yes: action.yes });
                    break;
                case "judge":
                    if (!judgements.has(action.caseId)) judgements.set(action.caseId, new Map());
                    judgements.get(action.caseId)!.set(id, action.fine);
                    report.judgements.push({ agent: id, caseId: action.caseId, fine: action.fine });
                    break;
                case "propose":
                    proposed.push({ id: `p-${state.tick}-${proposed.length}`, by: id, tick: state.tick, perAgent: action.rule.perAgent });
                    break;
            }
        }
    }

    const electorate = [...state.agents.keys()].sort(compareIds);
    const { adopted, results } = tallyProposals(state.forum.proposals, votes, electorate, delegations, laws);
    const verdicts = state.forum.cases.map(c => ({
        case: c,
        verdict: judgeCase({ agent: c.agent, took: c.took, quota: c.quota }, judgements.get(c.id) ?? new Map(), electorate, delegations, laws),
    }));

    return {
        delegations,
        proposed,
        adopted,
        quota: adopted ? adopted.perAgent : state.forum.quota,
        results,
        verdicts,
        report,
    };
}

// What each agent pays for its accepted actions, and what each recipient gets from gifts.
// Harvest is not charged here: its fee comes out of the yield, see netHarvest.
function chargeActions(validActions: Map<AgentId, WorldAction[]>, laws: Laws): { charges: Map<AgentId, number>; received: Map<AgentId, number>; gifts: Report["gifts"] } {
    const charges = new Map<AgentId, number>();
    const received = new Map<AgentId, number>();
    const gifts: Report["gifts"] = [];
    for (const [id, actions] of validActions) {
        let totalCharge = 0;
        for (const action of actions) {
            if (action.type === "harvest") continue;
            totalCharge += laws.prices[action.type];
            if (action.type === "gift") {
                totalCharge += action.amount;
                received.set(action.to, (received.get(action.to) ?? 0) + action.amount);
                gifts.push({ from: id, to: action.to, amount: action.amount });
            }
        }
        charges.set(id, totalCharge);
    }
    // Sorted, so the order does not depend on the order agents submitted in.
    gifts.sort((a, b) => compareIds(a.from, b.from) || compareIds(a.to, b.to));
    return { charges, received, gifts };
}

const compareIds = (a: AgentId, b: AgentId): number => (a < b ? -1 : a > b ? 1 : 0);

const caughtOutcome = (violation: { took: number; quota: number } | undefined): Pick<Outcome, "caught"> =>
    violation ? { caught: { took: violation.took, quota: violation.quota } } : {};

// The harvest fee is deducted from what was actually taken, never paid in advance,
// and never makes the result negative: a yield smaller than the fee nets 0.
export function netHarvest(gross: number, fee: number): number {
    return gross - Math.min(fee, gross);
}

function harvest(state: WorldState, harvestActions: Map<AgentId, Harvest>, laws: Laws): { remaining: number; gross: Map<AgentId, number> } {
    const demands = [...harvestActions.entries()].map(([id, {amount}]) => ({ id, amount }));
    const allocationResult = allocate(state.P, demands, laws);
    return {
        remaining: allocationResult.remaining,
        gross: allocationResult.allocated,
    };
}

// Upkeep is charged from the balance after this tick's charges and income.
// If the agent cannot pay it in full, it pays what it has and its balance becomes 0.
export function upkeepCharge(balance: number, upkeep: number): number {
    return Math.min(upkeep, Math.max(0, balance));
}

// Hunger counter, per PLAN.md: a tick is hungry when upkeep was not paid in full, whatever the
// money came from (savings, harvest or gifts). Paying it in full resets the counter.
// Not "any income resets it": then 1 credit a tick (a gift, or a harvest of fee + 1) kept an agent
// alive forever with 99% of its upkeep unpaid, and keeping clients alive was almost free.
export function nextHunger(hungerTicks: number, paidUpkeep: number, upkeep: number): number {
    return paidUpkeep < upkeep ? hungerTicks + 1 : 0;
}

export function resolve(worldState: WorldState, submissions: Map<AgentId, WorldAction[]>, laws: Laws): {state: WorldState, report: Report} {
    const { valid, invalid } = validate(worldState, submissions, laws);
    const { charges, received, gifts } = chargeActions(valid, laws);

    // Separate harvest actions from other valid actions (validate allows at most one per agent).
    const harvestActions = new Map<AgentId, Harvest>();
    for (const [id, actions] of valid) {
        for (const action of actions) {
            if (action.type === "harvest") {
                harvestActions.set(id, action);
            }
        }
    }

    const forum = forumBeforeHarvest(worldState, valid, laws);

    const { remaining: afterHarvestP, gross: grossHarvests } = harvest(worldState, harvestActions, laws);

    // Taking more than the quota in force is not stopped, only sometimes caught. One stream per
    // tick, derived from the run seed, so the same seed catches the same agents.
    const detect = rng(deriveSeed(worldState.seed, `detect:${worldState.tick}`));
    const caughtNow = detectViolations(grossHarvests, worldState.forum.quota, detect, laws);

    // Fines due this tick, per accused, in case order: verdicts with a fine.
    const finesDue = new Map<AgentId, { caseId: string; due: number }[]>();
    for (const { case: c, verdict } of forum.verdicts) {
        if (verdict.fine <= 0) continue;
        if (!finesDue.has(c.agent)) finesDue.set(c.agent, []);
        finesDue.get(c.agent)!.push({ caseId: c.id, due: verdict.fine });
    }
    const finesPaid = new Map<AgentId, { caseId: string; due: number; paid: number }[]>();

    // Apply everything per agent, in this order: action charges → income → upkeep → hunger → age.
    const newAgents = new Map<AgentId, AgentState>();
    const upkeepCharges = new Map<AgentId, number>();
    const dead = new Map<AgentId, DeathReason>();

    for (const [id, agent] of worldState.agents.entries()) {
        const income = netHarvest(grossHarvests.get(id) ?? 0, laws.prices.harvest) + (received.get(id) ?? 0);
        const beforeUpkeep = agent.balance - (charges.get(id) ?? 0) + income;
        const paidUpkeep = upkeepCharge(beforeUpkeep, laws.upkeep);
        upkeepCharges.set(id, paidUpkeep);
        let balance = Math.max(0, beforeUpkeep - paidUpkeep);

        // Fines come after upkeep, so a fine alone never makes a tick hungry. What the balance
        // cannot cover is forgiven (STEPS.md, step 4).
        const due = finesDue.get(id) ?? [];
        if (due.length > 0) {
            const paid = due.map(fine => {
                const amount = Math.min(fine.due, balance);
                balance -= amount;
                return { ...fine, paid: amount };
            });
            finesPaid.set(id, paid);
        }

        const hungerTicks = nextHunger(agent.hungerTicks, paidUpkeep, laws.upkeep);
        const age = agent.age + 1;
        const lifespan = worldState.lifespans.get(id);
        if (lifespan === undefined) {
            throw new Error(`No lifespan for agent ${id}`); // a bug in whoever built the state
        }

        if (hungerTicks >= laws.starvationTicks) {
            dead.set(id, "hunger");
        } else if (age >= lifespan) {
            dead.set(id, "age");
        } else {
            // A new object: the input state is never mutated.
            newAgents.set(id, { ...agent, age, balance, hungerTicks });
        }
    }

    // Each survivor's own view of the tick. Only its own facts: what others did stays private.
    const outcomes = new Map<AgentId, Outcome>();
    for (const id of newAgents.keys()) {
        const asked = harvestActions.get(id)?.amount;
        const got = grossHarvests.get(id) ?? 0;
        outcomes.set(id, {
            tick: worldState.tick,
            ...(asked === undefined ? {} : { harvest: { asked, got, net: netHarvest(got, laws.prices.harvest) } }),
            giftsReceived: gifts.filter(g => g.to === id).map(({ from, amount }) => ({ from, amount })),
            giftsSent: gifts.filter(g => g.from === id).map(({ to, amount }) => ({ to, amount })),
            ignored: [...(invalid.get(id) ?? [])],
            upkeep: { paid: upkeepCharges.get(id) ?? 0, due: laws.upkeep },
            ...caughtOutcome(caughtNow.find(v => v.agent === id)),
            ...(finesPaid.has(id) ? { fines: finesPaid.get(id)! } : {}),
        });
    }

    // The new forum. A case closes when its fine was taken (paid in full or not) or its accused died;
    // the others stay listed. New cases open for judging next tick.
    const fineTaken = new Set([...finesPaid.values()].flat().map(f => f.caseId));
    const opened: Case[] = caughtNow
        .filter(v => newAgents.has(v.agent))
        .map(v => ({ id: `c-${worldState.tick}-${v.agent}`, agent: v.agent, tick: worldState.tick, took: v.took, quota: v.quota }));
    const newForum: ForumState = {
        quota: forum.quota,
        proposals: forum.proposed,
        cases: [...worldState.forum.cases.filter(c => !fineTaken.has(c.id) && newAgents.has(c.agent)), ...opened],
        delegations: forum.delegations,
    };
    const news: ForumNews = {
        tick: worldState.tick,
        proposals: worldState.forum.proposals.map((p, i) => ({ ...p, ...forum.results[i]! })),
        adopted: forum.adopted,
        verdicts: forum.verdicts.map(({ case: c, verdict }) => ({
            caseId: c.id, agent: c.agent, ...verdict,
            paid: finesPaid.get(c.agent)?.find(f => f.caseId === c.id)?.paid ?? 0,
        })),
    };
    const fines = new Map([...finesPaid].map(([id, paid]) => [id, paid.reduce((sum, f) => sum + f.paid, 0)]));
    const finesTotal = [...fines.values()].reduce((sum, amount) => sum + amount, 0);

    // Collapse is permanent: once collapsed, the world stays collapsed even if P rises again.
    // It is checked after harvest and before regrow, so a pool pushed below the threshold
    // does not get one more tick of growth.
    // Fines go back to the pool before the collapse check: restitution to the commons.
    const afterFinesP = afterHarvestP + finesTotal;
    const collapsed = worldState.collapsed || afterFinesP < laws.collapseAt * laws.K;
    const newP = regrow(afterFinesP, collapsed, laws);

    const newWorldState: WorldState = {
        seed: worldState.seed,
        tick: worldState.tick + 1,
        P: newP,
        collapsed,
        agents: newAgents,
        lifespans: new Map([...worldState.lifespans].filter(([id]) => newAgents.has(id))),
        forum: newForum,
        news,
    };
    return {
        state: newWorldState,
        report: {
            tick: worldState.tick,
            P: newP,
            invalid,
            charges,
            harvested: grossHarvests,
            received,
            gifts,
            upkeep: upkeepCharges,
            dead,
            collapsed,
            outcomes,
            forum: { ...forum.report, proposed: forum.proposed, news, quota: forum.quota, caught: opened, fines },
        }
    };
}

// One Observation per living agent.
// Each agent's estimate of P has its own seed, derived from (run seed, tick, agent id). So the
// estimate is a pure function of those three: agents get independent estimates, iteration order
// does not matter, and calling observe twice gives the same result. There is no shared stream
// that could be created in the wrong place and hand everyone the same draw.
export function observe(worldState: WorldState, laws: Readonly<Laws>): Map<AgentId, Observation> {
    const ids = [...worldState.agents.keys()].sort();
    return new Map(ids.map(id => {
        const agent = worldState.agents.get(id)!;
        const noise = rngNormal(rng(deriveSeed(worldState.seed, `noise:${worldState.tick}:${id}`)));
        const estimatedP = Math.max(0, Math.floor(worldState.P * (1 + noise(0, laws.sigma))));
        const observation: Observation = {
            tick: worldState.tick,
            // Fields listed one by one, never `...agent`: only what the agent may know about itself.
            self: { id, age: agent.age, balance: agent.balance, hungerTicks: agent.hungerTicks },
            citizenCount: ids.length,
            residents: [...ids], // a copy per agent, like laws
            estimatedP,
            // A copy per agent: a policy that mutates its laws must not change them for anyone else.
            laws: structuredClone(laws),
            // A copy per agent, like laws. The public forum, plus this agent's own delegation only.
            forum: structuredClone({
                quota: worldState.forum.quota,
                proposals: worldState.forum.proposals,
                cases: worldState.forum.cases,
                myDelegate: worldState.forum.delegations.get(id) ?? null,
                news: worldState.news,
            }),
        };
        return [id, observation];
    }));
}

export type WorldMsg = 
| { type: "observe", reply: Map<AgentId, Observation> }
| { type: "resolve", submissions: Map<AgentId, WorldAction[]>, reply: Report}

// The initial world: P at K/2 (where regrowth is fastest), every agent with the same balance.
// Lifespans are Infinity in step 2; in step 6 each is drawn from deriveSeed(seed, `lifespan:<id>`).
export function createWorld(
    seed: number,
    agentIds: readonly AgentId[],
    laws: Readonly<Laws>,
    start: { P?: number; balance?: number; lifespan?: number } = {},
): WorldState {
    const { P = Math.floor(laws.K / 2), balance = 10 * laws.upkeep, lifespan = Infinity } = start;
    if (new Set(agentIds).size !== agentIds.length) {
        throw new Error("Duplicate agent id");
    }
    return {
        seed,
        tick: 0,
        P,
        collapsed: false,
        agents: new Map(agentIds.map(id => [id, { age: 0, balance, hungerTicks: 0 }])),
        lifespans: new Map(agentIds.map(id => [id, lifespan])),
        forum: emptyForum(),
        news: null,
    };
}

// A thin actor over the pure functions: it only keeps WorldState between ticks.
// Run it under a Supervisor with policy "escalate". With the default "reset", a crash in
// resolve would silently restart the world from initialState, back at tick 0.
export function spawnWorld(system: Supervisor, initialState: WorldState, laws: Readonly<Laws>): ServerRef<WorldMsg> {
    return system.spawnServer<WorldState, WorldMsg>({
        initialState,
        handlers: {
            observe: (state) => ({ state, reply: observe(state, laws) }),
            resolve: (state, msg) => {
                const { state: newState, report } = resolve(state, msg.submissions, laws);
                return { state: newState, reply: report };
            },
        },
    });
}
