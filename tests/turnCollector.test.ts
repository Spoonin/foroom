import { afterEach, describe, expect, it } from "vitest";
import { Supervisor } from "@cue/core";
import { spawnTurnCollector } from "../src/world/turnCollector";
import type { AgentId, Submit, Tick } from "../src/contracts";

let system: Supervisor;
let crashes: unknown[];

function start() {
    crashes = [];
    system = new Supervisor({ onError: ({ error }) => { crashes.push(error); } }, { policy: "escalate" });
    const collector = spawnTurnCollector(system);
    let completions = 0;
    const open = (tick: Tick, expected: AgentId[]) => {
        const complete = new Promise<void>(resolve => {
            collector.cast({ type: "open", tick, expected, onComplete: () => { completions++; resolve(); } });
        });
        return complete;
    };
    const submit = (from: AgentId, tick: Tick, amount = 1) =>
        collector.cast({ type: "submit", from, tick, actions: [{ type: "harvest", amount }] });
    const close = async (tick: Tick) => [...(await collector.call({ type: "close", tick })).values()];
    return { collector, open, submit, close, completions: () => completions };
}

afterEach(() => {
    system.stop();
});

const amounts = (submits: Submit[]) => submits.map(s => [s.from, s.actions[0]?.type === "harvest" ? s.actions[0].amount : null]);

describe("TurnCollector", () => {
    it('completes once every expected agent has submitted, and close returns their submits', async () => {
        const { open, submit, close, completions } = start();
        const complete = open(0, ["a", "b"]);
        submit("a", 0);
        submit("b", 0);
        await complete;
        expect(amounts(await close(0))).toEqual([["a", 1], ["b", 1]]);
        expect(completions()).toBe(1);
    });

    it('does not complete while someone is missing; close still returns what arrived', async () => {
        const { open, submit, close, completions } = start();
        void open(0, ["a", "b"]);
        submit("a", 0);
        expect(amounts(await close(0))).toEqual([["a", 1]]);
        expect(completions()).toBe(0);
    });

    it('keeps the first submit from an agent and drops a duplicate', async () => {
        const { open, submit, close } = start();
        void open(0, ["a", "b"]);
        submit("a", 0, 1);
        submit("a", 0, 99);
        expect(amounts(await close(0))).toEqual([["a", 1]]);
    });

    it('drops a submit for another tick, and one from an agent it does not expect', async () => {
        const { open, submit, close } = start();
        void open(5, ["a"]);
        submit("a", 4); // a late answer to the previous tick
        submit("z", 5); // not a living agent this tick
        expect(await close(5)).toEqual([]);
    });

    it('drops submits that arrive after close, until the next open', async () => {
        const { open, submit, close } = start();
        void open(0, ["a"]);
        await close(0);
        submit("a", 0);
        const complete = open(1, ["a"]);
        submit("a", 1, 7);
        await complete;
        expect(amounts(await close(1))).toEqual([["a", 7]]);
    });

    it('completes at once when nobody is expected', async () => {
        const { open, close } = start();
        await open(0, []);
        expect(await close(0)).toEqual([]);
    });

    it('closing a tick that is not the open one is a bug, and is reported', async () => {
        const { open, close } = start();
        void open(3, []);
        await expect(close(2)).rejects.toThrow("close(2) while tick 3 is open");
    });
});
