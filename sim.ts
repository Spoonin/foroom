import { parseArgs } from "node:util";
import { Supervisor } from "@cue/core";

const { values: { ticks } } = parseArgs({ options: { ticks: { type: "string", short: "t", default: "1" } } });


if(!Number.isInteger(Number(ticks)) || Number(ticks) < 0) {
    console.error("Invalid number of ticks. Please provide a positive integer.");
    process.exit(1);
}

interface WorldState {
    tick: number;
}

type WorldMsg = { type: "step", reply: number };

const system = new Supervisor({ onError: ({ childId, error }) => console.error(`[${childId}]`, error) });

const world = system.spawnServer<WorldState, WorldMsg>({
    initialState: { tick: 0 },
    handlers: {
        step: (state) => {
            console.log(`foroom: world tick ${state.tick}`);
            const newState = { tick: state.tick + 1 };
            // Reply with the tick that was just processed (state.tick), not the next one.
            return { state:newState, reply: state.tick };
        }
    }
});

try {
    for (let i = 0; i < Number(ticks); i++) {
        const result = await world.call({ type: "step" });
        console.log(`foroom: world replied with tick ${result}`);
    }
} catch (error) {
    console.error("Error during simulation:", error);
    process.exitCode = 1;
} finally {
    system.stop();
    console.log("foroom: simulation completed, Supervisor stopped");
}
