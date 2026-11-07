// Entry point: pnpm sim. For now it only checks that @cue/core is wired up.
// Step 1: replace with a loop of empty ticks under a Supervisor (`pnpm sim --ticks 3`).
import { Supervisor } from "@cue/core";

const system = new Supervisor({ onError: ({ childId, error }) => console.error(`[${childId}]`, error) });
console.log("foroom: @cue/core is wired up, Supervisor created");
system.stop();
