// world.ts — see STEPS.md, step 2 (forum — step 4, births — step 6).
//

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

// Hunger counter, per PLAN.md:
// - any income this tick (net harvest or gifts received) resets it;
// - no income and a balance of 0 after upkeep (the agent is starving) increments it;
// - no income but savings left: not starving, counter at 0.
export function nextHunger(hungerTicks: number, income: number, balanceAfterUpkeep: number): number {
    if (income > 0) return 0;
    return balanceAfterUpkeep <= 0 ? hungerTicks + 1 : 0;
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

        const hungerTicks = nextHunger(agent.hungerTicks, income, balance);
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
export function observe(worldState: WorldState, laws: Laws): Map<AgentId, Observation> {
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
            estimatedP,
            laws,
        };
        return [id, observation];
    }));
}
