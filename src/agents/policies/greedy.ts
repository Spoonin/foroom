import type { Harvest, Policy } from "../../contracts";
import { fairShareAmount, fairSharePolicy } from "./fairShare";

const GREEDYNESS_KOEFF = 3;

export const greedyPolicy: Policy = (observation, inbox) => {

    const fairShare = fairShareAmount(observation);

    return [{type: "harvest", amount: fairShare * GREEDYNESS_KOEFF}];
}