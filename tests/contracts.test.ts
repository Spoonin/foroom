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
it('refuses fractional credit amounts', () => {
    expect(Action.safeParse({ type: "harvest", amount: 12.5 }).success).toBe(false);
    expect(Action.safeParse({ type: "gift", to: "a", amount: 0.1 }).success).toBe(false);
});
