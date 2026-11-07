import { expect, it } from "vitest";
import { Action, Harvest } from "../src/contracts";

it('refuses negative harvest amounts', () => {
    const harvestJSON = '{"type":"harvest","amount": -1}';

    expect(Harvest.safeParse(JSON.parse(harvestJSON)).success).toBe(false);
});

it('accepts zero harvest amounts', () => {
    const harvestJSON = '{"type":"harvest","amount": 0}';

    expect(Harvest.safeParse(JSON.parse(harvestJSON)).data).toEqual({ type: "harvest", amount: 0 }) ;
});

it('accepts positive harvest amounts', () => {
    const harvestJSON = '{"type":"harvest","amount": 1}';
    
    expect(Harvest.safeParse(JSON.parse(harvestJSON)).data).toEqual({ type: "harvest", amount: 1 }) ;
});

it('refuses non-numeric harvest amounts', () => {
    const harvestJSON = '{"type":"harvest","amount": "not a number"}';

    expect(Harvest.safeParse(JSON.parse(harvestJSON)).success).toBe(false);
});

it('refuses harvest without amount', () => {
    const harvestJSON = '{"type":"harvest","non": 111}';
    
    expect(Harvest.safeParse(JSON.parse(harvestJSON)).success).toBe(false);
});

it('refuses undeclared actions', () => {
    const stealActionJSON = '{"type":"steal"}';

    expect(Action.safeParse(JSON.parse(stealActionJSON)).success).toBe(false);
});