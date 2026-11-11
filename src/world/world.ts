// world.ts — see STEPS.md, step 2 (forum — step 4, births — step 6).
//

import type { ServerRef, Supervisor } from "@cue/core";
import { type Harvest, AgentId, type Laws, type WorldAction, type WorldState, type AgentState, type Report, type InvalidReason, type DeathReason, type Observation } from "../contracts";
import { deriveSeed, rng, rngNormal } from "../rng";

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
            return [action.rule.perAgent];
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
            if (!valid.has(id)) {
                valid.set(id, []);
            }
            valid.get(id)!.push(action);
        }
    }

    return { valid, invalid };
}

// What each agent pays for its accepted actions, and what each recipient gets from gifts.
// Harvest is not charged here: its fee comes out of the yield, see netHarvest.
function chargeActions(validActions: Map<AgentId, WorldAction[]>, laws: Laws): { charges: Map<AgentId, number>; received: Map<AgentId, number> } {
    const charges = new Map<AgentId, number>();
    const received = new Map<AgentId, number>();
    for (const [id, actions] of validActions) {
        let totalCharge = 0;
        for (const action of actions) {
            if (action.type === "harvest") continue;
            totalCharge += laws.prices[action.type];
            if (action.type === "gift") {
                totalCharge += action.amount;
                received.set(action.to, (received.get(action.to) ?? 0) + action.amount);
            }
        }
        charges.set(id, totalCharge);
    }
    return { charges, received };
}

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
    const { charges, received } = chargeActions(valid, laws);

    // Separate harvest actions from other valid actions (validate allows at most one per agent).
    const harvestActions = new Map<AgentId, Harvest>();
    for (const [id, actions] of valid) {
        for (const action of actions) {
            if (action.type === "harvest") {
                harvestActions.set(id, action);
            }
        }
    }

    const { remaining: afterHarvestP, gross: grossHarvests } = harvest(worldState, harvestActions, laws);

    // Apply everything per agent, in this order: action charges → income → upkeep → hunger → age.
    const newAgents = new Map<AgentId, AgentState>();
    const upkeepCharges = new Map<AgentId, number>();
    const dead = new Map<AgentId, DeathReason>();

    for (const [id, agent] of worldState.agents.entries()) {
        const income = netHarvest(grossHarvests.get(id) ?? 0, laws.prices.harvest) + (received.get(id) ?? 0);
        const beforeUpkeep = agent.balance - (charges.get(id) ?? 0) + income;
        const paidUpkeep = upkeepCharge(beforeUpkeep, laws.upkeep);
        upkeepCharges.set(id, paidUpkeep);
        const balance = Math.max(0, beforeUpkeep - paidUpkeep);

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

    // Collapse is permanent: once collapsed, the world stays collapsed even if P rises again.
    // It is checked after harvest and before regrow, so a pool pushed below the threshold
    // does not get one more tick of growth.
    const collapsed = worldState.collapsed || afterHarvestP < laws.collapseAt * laws.K;
    const newP = regrow(afterHarvestP, collapsed, laws);

    const newWorldState: WorldState = {
        seed: worldState.seed,
        tick: worldState.tick + 1,
        P: newP,
        collapsed,
        agents: newAgents,
        lifespans: new Map([...worldState.lifespans].filter(([id]) => newAgents.has(id))),
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
            upkeep: upkeepCharges,
            dead,
            collapsed,
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
