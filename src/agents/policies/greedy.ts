// greedy.ts — see STEPS.md, step 2.
//
// Takes `factor` times its fair share. The default factor 3 is clearly unsustainable but does not
// swallow everyone else in a mixed population; a large factor gives the "grab everything" variant.

import type { Policy } from "../../contracts";
import { fairShareAmount } from "./fairShare";

export function makeGreedyPolicy(factor: number): Policy {
    return (observation) => [{ type: "harvest", amount: Math.floor(fairShareAmount(observation) * factor) }];
}

export const greedyPolicy: Policy = makeGreedyPolicy(3);
