// random.ts — see STEPS.md, step 2.
//
// Harvests a random whole amount between 0 and maxFactor × the fair share. With the default
// maxFactor = 2 the average harvest equals the fair share, so the policy is "fair on average,
// noisy tick to tick": a baseline for agents that have no strategy at all.

import type { Policy } from "../../contracts";
import { rngInt } from "../../rng";
import { fairShareAmount } from "./fairShare";

// `random` is the agent's own stream, e.g. rng(deriveSeed(runSeed, `policy:${id}`)).
// It is passed in, never created here: then the same run seed gives the same harvests,
// and another agent's draws never shift this agent's sequence.
export function makeRandomPolicy(random: () => number, maxFactor = 2): Policy {
    const int = rngInt(random);
    return (observation) => {
        const max = Math.floor(fairShareAmount(observation) * maxFactor);
        return [{ type: "harvest", amount: int(0, max) }]; // rngInt includes both ends
    };
}
