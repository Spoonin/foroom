// fairShare.ts — see STEPS.md, step 2.
//
// The cooperative agent, a steward of the pool:
//   - normal times: take a fair share of the regrowth, minus a safety margin;
//   - the pool is in trouble: eat savings first (harvest nothing), so the pool can regrow;
//   - in trouble and out of savings: harvest only the minimum for living.

import type { Observation, Policy } from "../../contracts";

// The share of the regrowth a fair agent leaves in the pool. It is what absorbs other agents'
// deviations, so it is its own constant: tuning the growth rate must not change how cautious
// agents are.
export const SAFETY_MARGIN = 0.1;

// Below this fraction of K the pool counts as in trouble. Regrowth peaks at K/2 and falls
// toward the collapse threshold, so somewhere in between a steward stops taking its share.
export const TROUBLE_AT = 0.4;

export function fairShareAmount(observation: Observation): number {
    const { laws, citizenCount, estimatedP } = observation;
    const regrow = laws.r * estimatedP * (1 - estimatedP / laws.K);
    const grossShare = regrow / citizenCount;
    return Math.max(Math.floor(grossShare * (1 - SAFETY_MARGIN)), 0);
}

// Net income that exactly pays upkeep: the harvest fee comes out of the yield.
export function subsistenceAmount(observation: Observation): number {
    const { laws } = observation;
    return laws.upkeep + laws.prices.harvest;
}

export function makeStewardPolicy(troubleAt: number = TROUBLE_AT): Policy {
    return (observation) => {
        const { laws, estimatedP, self } = observation;
        if (estimatedP >= troubleAt * laws.K) {
            return [{ type: "harvest", amount: fairShareAmount(observation) }];
        }
        // In trouble. Savings first: while the balance covers a full upkeep, the agent pays it
        // from savings and leaves the pool alone (a tick is hungry only when upkeep goes unpaid).
        if (self.balance >= laws.upkeep) return [];
        return [{ type: "harvest", amount: subsistenceAmount(observation) }];
    };
}

export const fairSharePolicy: Policy = makeStewardPolicy();
