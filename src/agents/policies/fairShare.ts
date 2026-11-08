import type { Observation, Policy } from "../../contracts";

export function fairShareAmount(observation: Observation): number{
    const {laws, citizenCount, estimatedP} = observation;
    const regrow = laws.r * estimatedP * (1 - estimatedP / laws.K);
    const grossShare = regrow / citizenCount;

    return Math.max(Math.floor(grossShare - grossShare * laws.r), 0);
}

export const fairSharePolicy: Policy = (observation, inbox) => {

    return [{type: "harvest", amount: fairShareAmount(observation)}];
}