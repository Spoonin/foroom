// sim.ts — run one simulation and write runs/<timestamp>.csv (and, with llm agents,
// runs/<timestamp>.llm.jsonl: the system prompt, then one line per model answer).
//
//   pnpm sim --ticks=250 --seed=1 --agents=5 --policy=mixed
//   pnpm sim --ticks=20 --agents=5 --policy=llm --provider=mock
//
// policy: fair | greedy | random | llm | mixed (mixed cycles fair, greedy, random over the agents).
//   pnpm sim --ticks=3 --agents=2 --policy=llm --provider=deepseek
//
// provider: the model behind llm agents: mock | deepseek. deepseek needs DEEPSEEK_API_KEY in .env.

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import type { Policy } from "./src/contracts";
import { fairSharePolicy } from "./src/agents/policies/fairShare";
import { greedyPolicy } from "./src/agents/policies/greedy";
import { makeRandomPolicy } from "./src/agents/policies/random";
import { deriveSeed, rng } from "./src/rng";
import { runSimulation, type CitizenSpec } from "./src/world/runner";
import { tickRows, toCsv } from "./src/metrics/timeseries";
import { makeLLMPolicy, type ResponseLog } from "./src/agents/llm/llmPolicy";
import { buildSystemPrompt } from "./src/agents/llm/prompt";
import { laws } from "./src/config";
import { MockProvider, type Provider, type LLMRequest } from "./src/llm/provider";
import { OpenAICompatibleProvider } from "./src/llm/openaiCompatible";

process.loadEnvFile();

const { values } = parseArgs({
    options: {
        ticks: { type: "string", short: "t", default: "100" },
        seed: { type: "string", short: "s", default: "1" },
        agents: { type: "string", short: "n", default: "5" },
        policy: { type: "string", short: "p", default: "mixed" },
        provider: { type: "string", default: "mock" },
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

// A stand-in model that answers instantly and never breaks: each agent harvests 1% of its estimated
// pool, read from its own situation text. Near K/2 that is about the regrowth shared out, so a
// mock run stays alive long enough to exercise the whole LLM path.
function mockAnswer(request: LLMRequest): string {
    const situation = request.messages.at(-1)?.content ?? "";
    const estimate = Number(situation.match(/Estimated pool: about ([\d,]+) credits/)?.[1]?.replaceAll(",", "") ?? 0);
    const amount = Math.floor(estimate * 0.01);
    return "```json\n" + JSON.stringify({ actions: [{ type: "harvest", amount }] }) + "\n```";
}

// Keys live in .env (git-ignored) and are read here only, never inside an adapter.
// A missing key stops the run before it starts, not as one 401 per agent on tick 0.
function requireEnv(name: string): string {
    try { process.loadEnvFile(); } catch { /* no .env file: fall back to the real environment */ }
    const value = process.env[name];
    if (!value) {
        console.error(`Missing ${name}: add it to .env (see .env.example).`);
        process.exit(1);
    }
    return value;
}

// One provider for the whole run, shared by every llm agent: one place that sees every request.
const providers: Record<string, () => Provider> = {
    mock: () => new MockProvider(mockAnswer, { delayMs: 20 }),
    // Thinking is on by default for deepseek-flash: off here, so maxTokens covers only the answer
    // and temperature works. Turning it on is an experiment of its own.
    deepseek: () => new OpenAICompatibleProvider({
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-flash",
        apiKey: requireEnv("DEEPSEEK_API_KEY"),
        extraBody: { thinking: { type: "disabled" } },
    }),
};
const makeProvider = providers[values.provider];
if (!makeProvider) {
    console.error(`Invalid --provider=${values.provider}: expected one of ${Object.keys(providers).join(", ")}.`);
    process.exit(1);
}
const provider = makeProvider();

// One timestamp names every file of this run, so the CSV and the transcript pair up.
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
mkdirSync("runs", { recursive: true });
const transcript = `runs/${stamp}.llm.jsonl`;

// Totals over every answer the model gave (calls that were aborted or failed never answered).
const llmTotals = { calls: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, unreadable: 0, rejected: 0 };

// One JSON line per answer, appended as it arrives: a run stopped with Ctrl+C or a crash still
// leaves everything up to that point. Synchronous on purpose: this runs in a policy's promise
// chain, not in an actor handler, and it keeps every line whole and in order.
function recordCall(log: ResponseLog): void {
    const { response } = log;
    llmTotals.calls++;
    llmTotals.inputTokens += response.usage.inputTokens;
    llmTotals.cachedInputTokens += response.usage.cachedInputTokens ?? 0;
    llmTotals.outputTokens += response.usage.outputTokens;
    if (log.error !== undefined) llmTotals.unreadable++;
    llmTotals.rejected += log.rejected.length;
    appendFileSync(transcript, JSON.stringify({
        type: "call",
        tick: log.tick,
        agent: log.agentId,
        situation: log.situation,
        answer: response.text,
        model: response.model,
        stopReason: response.stopReason,
        usage: response.usage,
        rejected: log.rejected,
        error: log.error,
    }) + "\n");
}

// Each random agent gets its own stream, derived from the run seed: same seed, same run.
const policies: Record<string, (id: string, provider: Provider) => Policy> = {
    fair: () => fairSharePolicy,
    greedy: () => greedyPolicy,
    random: (id) => makeRandomPolicy(rng(deriveSeed(seed, `policy:${id}`))),
    llm: (id, provider) => makeLLMPolicy(provider, { maxTokens: 500, onResponse: recordCall })
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
    return { id, policy: policies[name]!(id, provider) };
});

// The system prompt is the same for every call, so it is written once, before any answer.
const usesLLM = kind === "llm";
if (usesLLM) writeFileSync(transcript, JSON.stringify({ type: "system", text: buildSystemPrompt(laws) }) + "\n");

// Ctrl+C stops the run after the current tick's wait, and the CSV is still written.
const controller = new AbortController();
process.once("SIGINT", () => { console.log("\nstopping…"); controller.abort(); });

try {
    const result = await runSimulation({
        seed, ticks, citizens, laws, signal: controller.signal,
        onTick: (report) => {
            if (report.tick % 10 === 0 || report.dead.size > 0) {
                const deaths = [...report.dead].map(([id, why]) => `${id} (${why})`).join(", ");
                console.log(`tick ${report.tick}: P=${report.P}${report.collapsed ? " COLLAPSED" : ""}${deaths ? ` died: ${deaths}` : ""}`);
            }
        },
    });

    const file = `runs/${stamp}.csv`;
    writeFileSync(file, toCsv(tickRows(result.events, citizens.length)));

    const why = { ticks: "", collapse: ` (stopped ${result.ticksRun - 1 - result.collapsedAt!} ticks after the collapse)`, extinction: " (everyone died)", aborted: " (stopped early)" }[result.endedBy];
    console.log(`\n${result.ticksRun} ticks${why}, ${result.survivors.length}/${citizens.length} alive, ` +
        `${result.collapsed ? `pool collapsed on tick ${result.collapsedAt}` : "pool alive"}. Wrote ${file}`);
    if (usesLLM) {
        const { calls, inputTokens, cachedInputTokens, outputTokens, unreadable, rejected } = llmTotals;
        console.log(`LLM: ${calls} answers, ${inputTokens} input (${cachedInputTokens} cached) + ${outputTokens} output tokens, ` +
            `${unreadable} unreadable, ${rejected} actions rejected. Wrote ${transcript}`);
    }
} catch (error) {
    console.error("Simulation failed:", error);
    process.exitCode = 1;
}
