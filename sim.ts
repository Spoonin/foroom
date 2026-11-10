// sim.ts — run one simulation and write runs/<timestamp>.csv.
//
//   pnpm sim --ticks=250 --seed=1 --agents=5 --policy=mixed
//
// policy: fair | greedy | random | mixed (mixed cycles fair, greedy, random over the agents).

import { mkdir, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import type { Policy } from "./src/contracts";
import { fairSharePolicy } from "./src/agents/policies/fairShare";
import { greedyPolicy } from "./src/agents/policies/greedy";
import { makeRandomPolicy } from "./src/agents/policies/random";
import { deriveSeed, rng } from "./src/rng";
import { runSimulation, type CitizenSpec } from "./src/world/runner";
import { tickRows, toCsv } from "./src/metrics/timeseries";

const { values } = parseArgs({
    options: {
        ticks: { type: "string", short: "t", default: "100" },
        seed: { type: "string", short: "s", default: "1" },
        agents: { type: "string", short: "n", default: "5" },
        policy: { type: "string", short: "p", default: "mixed" },
    },
});

function wholeNumber(name: string, raw: string, min: number): number {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min) {
        console.error(`Invalid --${name}=${raw}: expected a whole number ≥ ${min}.`);
        process.exit(1);
    }
    return n;
}

const ticks = wholeNumber("ticks", values.ticks, 0);
const seed = wholeNumber("seed", values.seed, 0);
const agents = wholeNumber("agents", values.agents, 1);

// Each random agent gets its own stream, derived from the run seed: same seed, same run.
const policies: Record<string, (id: string) => Policy> = {
    fair: () => fairSharePolicy,
    greedy: () => greedyPolicy,
    random: (id) => makeRandomPolicy(rng(deriveSeed(seed, `policy:${id}`))),
};
const mixed = ["fair", "greedy", "random"] as const;

const kind = values.policy;
if (kind !== "mixed" && !(kind in policies)) {
    console.error(`Invalid --policy=${kind}: expected one of ${[...Object.keys(policies), "mixed"].join(", ")}.`);
    process.exit(1);
}

const citizens: CitizenSpec[] = Array.from({ length: agents }, (_, i) => {
    const id = `agent-${String(i + 1).padStart(2, "0")}`;
    const name = kind === "mixed" ? mixed[i % mixed.length]! : kind;
    return { id, policy: policies[name]!(id) };
});

// Ctrl+C stops the run after the current tick's wait, and the CSV is still written.
const controller = new AbortController();
process.once("SIGINT", () => { console.log("\nstopping…"); controller.abort(); });

try {
    const result = await runSimulation({
        seed, ticks, citizens, signal: controller.signal,
        onTick: (report) => {
            if (report.tick % 10 === 0 || report.dead.size > 0) {
                const deaths = [...report.dead].map(([id, why]) => `${id} (${why})`).join(", ");
                console.log(`tick ${report.tick}: P=${report.P}${report.collapsed ? " COLLAPSED" : ""}${deaths ? ` died: ${deaths}` : ""}`);
            }
        },
    });

    await mkdir("runs", { recursive: true });
    const file = `runs/${new Date().toISOString().replace(/[:.]/g, "-")}.csv`;
    await writeFile(file, toCsv(tickRows(result.events, citizens.length)));

    console.log(`\n${result.ticksRun} ticks${result.aborted ? " (stopped early)" : ""}, ${result.survivors.length}/${citizens.length} alive, ` +
        `${result.collapsed ? "pool collapsed" : "pool alive"}. Wrote ${file}`);
} catch (error) {
    console.error("Simulation failed:", error);
    process.exitCode = 1;
}
