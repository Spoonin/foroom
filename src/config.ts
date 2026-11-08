// config.ts — see STEPS.md, step 2.
//
// Default world parameters: r, K, collapseAt, σ, upkeep, prices of world actions,
// maxMessagesPerTick, maxMessageChars, L, T, starvationTicks.

import type { Laws } from "./contracts";

const readonly = <T extends object>(obj: T): Readonly<T> => Object.freeze(obj);

// Credits are integers, so amounts are scaled ×100 (like cents): flooring a share then loses
// at most 1 credit out of hundreds.
export const laws = readonly<Laws>({
    r: 0.1, // growth rate
    K: 100_000, // carrying capacity, in credits
    collapseAt: 0.1, // fraction of K below which the pool collapses for good
    maxHarvestFraction: 0.5, // at most half of the pool can be harvested in one tick
    sigma: 0.05, // standard deviation of the noise on agents' estimate of P (not on growth)
    upkeep: 100, // upkeep cost per agent per tick
    prices: Object.freeze({
        harvest: 100, // a fee taken from the yield, not paid in advance
        gift: 0,
        propose: 1000,
        vote: 100,
        delegate: 100,
        pair: 500,
        spawn: 2000,
    }),
    starvationTicks: 3, // number of ticks an agent can survive without food before dying
});
