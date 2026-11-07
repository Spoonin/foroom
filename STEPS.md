# foroom — step-by-step implementation plan

Design and motivation are in [PLAN.md](PLAN.md). This file is the order of work.

**You write all the code. Claude reviews and advises.**

The labels below mark code layers, not who writes them:
- 🧱 **Infrastructure** — world, forum, ledger, LLM providers, metrics, runner;
- ✍️ **Agent logic** — everything in `src/agents/`.

**How each step goes:**
1. Tests first, from the step's "Tests" section: they pin down what "done" means.
2. Then code, until the tests are green.
3. **Review:** "review step N". Claude runs the tests, reads the changes and checks them
   against the step's criteria and its "Review checklist".
4. Commit, next step.

Stuck mid-step? Ask right away, don't wait for review: you get a hint, not finished code.

---

## Project layout

```
foroom/
├── sim.ts                    🧱 CLI: pnpm sim --agents greedy:3,fairShare:2 --ticks 100 --seed 1
├── src/
│   ├── contracts.ts          🧱 the boundary between worlds: Observation, Action, Policy (+ zod schemas)
│   ├── config.ts             🧱 default parameters
│   ├── rng.ts                🧱 seeded RNG
│   ├── world/
│   │   ├── world.ts          🧱 World actor: pool, turn resolution, prices, aging, death, births
│   │   ├── forum.ts          🧱 proposals, vote tally with delegation
│   │   ├── ledger.ts         🧱 append-only event log
│   │   ├── chronicler.ts     🧱 world summary from the ledger (deterministic)
│   │   └── runner.ts         🧱 tick loop, turn collection, turn deadline, spawn/stop of actors
│   ├── llm/                  🧱 LLMProvider + Mock / OpenAI-compatible / Anthropic + token budget
│   ├── metrics/              🧱 concentration, institutionalization, cost of governance, demography
│   └── agents/               ✍️ agent logic
│       ├── citizen.ts        ✍️ the agent actor
│       ├── policies/         ✍️ greedy.ts, fairShare.ts, random.ts, (leader.ts, follower.ts)
│       └── llm/              ✍️ prompt.ts, parse.ts, memory.ts, llmPolicy.ts, values.ts
└── tests/                    tests for both layers
```

## The boundary: `src/contracts.ts`

An agent sees the world **only** through `Observation` and affects it **only** through `Action[]`.

```ts
type AgentId = string;

interface Observation {
  tick: number;
  self: { id: AgentId; age: number; balance: number; hungerTicks: number; parents: AgentId[]; children: AgentId[] };
                                           // the agent does NOT see its own lifespan, only the rule in laws
  worldSummary: string;                    // from the Chronicler; contains no balances of others
  poolEstimate: number;                    // P with noise σ
  laws: {
    regrowthRate: number; capacity: number; collapseAt: number; upkeep: number; prices: Prices;
    lifespan: { mean: number; spread: 0.25 };   // the rule, not the agent's own value
    maxChildren: 3;                             // per lifetime
    starvationTicks: 3;                         // this many starving ticks in a row — death
  };
  alive: AgentId[];
  // from step 4:
  inbox: { from: AgentId; to: AgentId | "all"; text: string }[];
  openProposals: Proposal[];
  activeQuota: number | null;
  myDelegate: AgentId | null;
}

type Action =
  | { type: "harvest"; amount: number }
  | { type: "say"; to: AgentId | "all"; text: string }            // step 4
  | { type: "propose"; rule: { kind: "quota"; perAgent: number } } // step 4
  | { type: "vote"; proposalId: string; yes: boolean }             // step 4
  | { type: "delegate"; to: AgentId | null }                       // step 4
  | { type: "revise_values"; text: string; reason: string }        // step 3
  | { type: "pair"; with: AgentId }                                // step 6
  | { type: "spawn"; partner: AgentId; count: 1 | 2 | 3; endowment: number; upbringing: string }; // step 6

interface Policy {
  decide(obs: Observation): Action[] | Promise<Action[]>;
}
```

**World validates everything itself.** An invalid action (no money, unknown id, quota exceeded)
is dropped and logged as `rejected`. An agent cannot break the world, so an LLM can be given
full freedom.

## Tick protocol

```
Runner ──observe──▶ World                       → an Observation for every living agent
Runner ──cast {tick, obs, replyTo}──▶ Citizen×N
Citizen ──cast {submit, from, tick, actions}──▶ replyTo     (exactly once per tick)
Runner waits for all, or turnDeadlineMs         → late agents get an empty turn (timeout in the ledger)
Runner ──resolve(submissions)──▶ World
   phases: delegate → vote → propose → say → harvest (with quota) → prices → upkeep → aging/death → births
World ──TickReport {deaths, births}──▶ Runner   → stop() the dead, spawn the newborns
```

Agents receive `say` messages in the `inbox` of the **next** tick. There is no direct
actor-to-actor messaging between agents in v0: all communication goes through the world, and
the ledger sees it.

## ⚠️ The key cue fact for agents (verified)

The cue scheduler awaits each actor's `drain()` **sequentially**. Experiment: 5 actors, each
doing a 200 ms `await` in its handler. They finished at **205, 405, 606, 808, 1009 ms**, strictly
one after another. Therefore:

- **`await`ing an LLM call inside a handler queues up the entire simulation**: agents think one
  at a time, and World stalls.
- The `Handlers` type also requires a synchronous state return.

The fix is the **pipe-to-self** pattern (like `pipeTo` in Akka): the handler *starts* the promise
and returns state immediately; the result arrives as a separate message to itself.

```ts
tick: (state, msg) => {
  policy.decide(msg.obs)
    .then(actions => self.cast({ type: "decided", tick: msg.obs.tick, actions }))
    .catch(err   => self.cast({ type: "decided", tick: msg.obs.tick, actions: [], error: String(err) }));
  return { ...state, pendingTick: msg.obs.tick, replyTo: msg.replyTo };
},
decided: (state, msg) => {
  if (msg.tick !== state.pendingTick) return state;  // late answer from a previous tick — drop it
  state.replyTo.cast({ type: "submit", from: state.id, tick: msg.tick, actions: msg.actions });
  return { ...state, pendingTick: null };
},
```

This is a sketch, not finished code: you will write your own version in step 3.
Hint: get the `self` ref inside the handler via a closure — a variable that is assigned the
result of `spawnServer`.

---

## Step 1. Skeleton

**🧱:** `git init`, pnpm, TS, `tsx`, `vitest`, `zod`; `@cue/core` via
`"link:../cue/packages/core"`. After changes in cue, rebuild `dist/` with
`pnpm --filter @cue/core build` in the cue repo (JS via tsup, types via `tsc`);
`contracts.ts` with types and zod schemas; `sim.ts` that runs empty ticks under a Supervisor.

**✍️:** nothing yet. It is enough to have `Policy` and `Action` in `contracts.ts`.

**Tests:** one smoke test — the zod schema accepts a valid `harvest` and rejects `amount: -1`.

**Done when:** `pnpm sim --ticks 3` prints three ticks, `pnpm test` is green.

**Review checklist:** the cue import resolves to `dist`, not to the sources; the types in
`contracts.ts` are derived from the zod schemas (`z.infer`), not duplicated by hand.

## Step 2. World and rule-based agents

**🧱:** World (logistic pool, collapse threshold, proportional split under scarcity, noise σ,
upkeep, starvation, age, death by starvation and old age), Ledger, Runner, `runs/<ts>.csv`
output with `P(t)`. No offspring yet, so scenario tests use `lifespan = Infinity`.

**✍️:**
1. **`policies/greedy.ts`** — takes clearly more than its share.
2. **`policies/fairShare.ts`** — takes its share of the sustainable regrowth.
   Hint: regrowth is `r·P·(1 − P/K)`, all laws are in `obs.laws`, and you only know `P`
   approximately. What to do about the noise is your call.
3. **`policies/random.ts`** — random harvest; the RNG is passed into the constructor (determinism!).
4. **`citizen.ts`** — the actor: on `tick`, call the policy and send `submit` to `replyTo`.
   Policies are synchronous for now, so the straightforward version is fine. You will rework
   it in step 3, and that is part of the learning.

**Tests:**
- `policies.test.ts` — greedy takes more than fairShare; fairShare at `P = K/2` takes ≈ `rK/4/n`;
- `citizen.test.ts` — exactly one `submit` per tick with the correct `from` and `tick`;
- `scenario.test.ts` — 5 × greedy collapse the pool before tick 50; 5 × fairShare keep
  `P > collapseAt` for all 250 ticks.

Plus World tests: the split under scarcity is proportional to demand; below `collapseAt` the
pool does not grow; an agent without income for 3 ticks in a row dies of starvation, while
income on the 2nd tick resets the counter.

**Tip:** make the world math (`regrow`, `allocate`, `resolve`) **pure functions** over state,
and the World actor a thin wrapper. Then it is easy to test without actors and without async.

**Review checklist:** determinism (one seed → one CSV, check with two runs); no `Math.random`
anywhere; the order in which agents are processed does not depend on who submitted first.

## Step 3. LLM agent

**🧱:**
- `LLMProvider`;
- `MockProvider` with canned responses and a delay;
- `OpenAICompatibleProvider` (OpenAI, OpenRouter, Ollama, LM Studio) and `AnthropicProvider` — on plain `fetch`, no SDK;
- a `BudgetedProvider` wrapper: logs `usage` and stops the run at the global budget;
- config `llm: { provider, baseUrl, model, maxTokens }` and `.env`.

**✍️:**
1. **`llm/prompt.ts`** — `buildPrompt(obs, memory, values) → { system, messages }`.
   Describe the world, the actions and the response format. **Do not name forms of governance**
   (anarchy, democracy and so on) — this is a requirement of the experiment.
2. **`llm/parse.ts`** — `parseActions(text) → { actions, errors }` using the zod schemas from
   `contracts.ts`. Worth covering in tests: JSON inside a ``` block, text before and after,
   unknown `type`, negative `amount`, empty response.
3. **`llm/llmPolicy.ts`** — the glue: prompt → provider → parse. Decide what to do on a parse
   error: an empty turn, or one retry with the error text. This decision affects token usage.
4. **`llm/memory.ts`** — the personal log **in full**: own actions and messages plus private
   messages addressed to the agent. The world picture arrives in `obs.worldSummary`; there is
   no need to keep its history.
5. **`llm/values.ts`** — the first call of an agent's life: from `worldSummary` (and upbringing,
   from step 6) the agent formulates its goals and priorities. The result is stored in Citizen
   state and included in every prompt. Revision is the `revise_values` action on a normal turn:
   Citizen replaces its values, World writes the new version to the ledger. Tests on
   `MockProvider`: the initial formulation is requested exactly once; after `revise_values` the
   next prompt contains the new version.
6. **Rework `citizen.ts` to pipe-to-self.** Test: 5 agents with `MockProvider` (200 ms delay)
   must finish in ~200 ms, not ~1000.

**Done when:** `pnpm sim --agents llm:3,fairShare:2 --ticks 20 --provider ollama` completes,
and the ledger shows the turns and real token usage.

**Tip:** get everything green on `MockProvider` first, and only then switch to a real model.
Check the network adapters with a separate manual script, not with unit tests.

**Review checklist:** not a single `await` in actor handlers; keys only from `.env` (and `.env`
is in `.gitignore`); the token budget really stops the run; the prompt contains no regime names.

## Step 3.5 (optional). Agent on LangGraph

The goal is to understand what an agent framework gives you compared with the hand-written
loop from step 3. LangGraph is used **only inside a single agent**, behind the `Policy`
boundary. The collective stays on cue actors: a shared graph state would destroy the
information asymmetry the experiment relies on.

**✍️:** `src/agents/llm/graphPolicy.ts` — a second `Policy` implementation on `@langchain/langgraph`:

```
observe → reflect → plan → draft → validate ──invalid──▶ draft  (≤ 2 attempts)
                                            └─ok──▶ Action[]
```

- reuse `prompt.ts` and `parse.ts` from step 3 inside the nodes instead of rewriting them;
- connect the model via a LangChain integration, or wrap your `LLMProvider` in a node.
  The second option keeps shared token accounting through `BudgetedProvider`;
- the CLI gets a `graph` agent type: `--agents llm:3,graph:3,fairShare:2`.

**Tests:** on `MockProvider` — an invalid first answer leads to a second attempt, two invalid
answers in a row give an empty turn; the graph never makes more model calls than allowed.

**What to compare** (mixed population, several seeds):

| Metric | Question |
|---|---|
| share of empty turns due to parse errors | does the validation loop help? |
| real tokens per turn | how much do `reflect` and `plan` cost? |
| behavior and resulting regime | does a "reflective" agent think differently politically? |

**Review checklist:**
- `graph.invoke()` is called via pipe-to-self, with no `await` in the handler;
- memory has a single source of truth: either actor state or a checkpointer with
  `thread_id = agentId`, not both (otherwise memory diverges after a restart under the Supervisor);
- the LangChain dependency does not leak outside `graphPolicy.ts`.

## Step 4. Forum

**🧱:** Forum — proposals with ids, a 1-tick voting window, a tally with transitive delegation
and cycle protection. World caps harvest at the adopted quota and charges action prices; if
there is not enough money — `rejected`. `Observation` gains `inbox`, `openProposals`,
`activeQuota`, `myDelegate`.

**✍️:**
1. A forum section in the prompt: what is visible, which actions exist, what they cost.
2. Teach the rule-based policies to vote: fairShare votes "yes" for a quota ≤ its own estimate,
   greedy votes "no".
3. **`leader.ts`** and **`follower.ts`**. The leader proposes a quota and asks others to
   delegate. The follower delegates to the most active proposer. This is the "concentration"
   reference used to calibrate the metrics before any LLM is involved.

**Tests:** a fairShare majority adopts its quota; delegation changes the outcome; a delegation
cycle does not break the tally.

**Review checklist:** the vote tally is a pure function; what happens to the vote of an agent
who delegated and also voted itself (the rule must be explicit and described in the prompt).

## Step 5. Metrics

**🧱:**
- HHI of decision weight, institutionalization, cost of governance, lineage depth;
- control: real tokens per turn per agent;
- `runs/<ts>.json` and a short console summary.

Calibration runs on your policies:

| Composition | Expected signal |
|---|---|
| leader + followers | high concentration |
| all fairShare with voting | low concentration, high institutionalization |
| all greedy | anarchy |

**✍️:** check that the metrics see what you expect from your policies. If not, the bug is
either in the metric or in the expectation. Figure out which.

## Step 6. Offspring

**🧱:** World handles `pair` (a mutual offer, valid for k ticks; a one-off deal, the pair has
no shared balance) and `spawn` (minimum age `L/4`, at most 3 children per parent per lifetime,
`endowment` debited, `maxPopulation`, `P > P_birth`). Lineage — parent ids and depth. A newborn
delegates its vote to a parent by default. Runner spawns child actors under the Supervisor and
calls `stop()` on the dead.

**✍️:**
1. **Upbringing:** the parent writes the `upbringing` text in the same turn as `spawn`, with no
   separate LLM call. The child gets it in its initial memory and passes it to `values.ts`
   together with `worldSummary`. There are no numeric genes: upbringing is the only channel of
   value inheritance.
2. **The reproduction decision** in the rule-based policies (e.g. fairShare reproduces when
   balance > X and the pool is healthy) and a prompt section for the LLM.
3. A child may revoke its delegation to a parent — that is its own policy.

**Done when:** a rule-based 250-tick run (default `lifespan`: 40 ± 25%) reaches lineage depth ~10.

**Review checklist:** no dangling refs to dead actors in Runner (or in `Registry`, if you use
it); dead letters from `stop()` are logged, not lost; the population neither explodes nor dies
out across several seeds.

---

## Defaults adopted (open to revision)

- The laws of nature (`r`, `K`, `collapseAt`, prices) are known to agents; the current `P` only with noise.
- The voting window is 1 tick; a quota stays in force until replaced by a new one.
- Messages are delivered on the next tick.
- In step 2 agents are immortal; lifespan is switched on in step 6.
- The Chronicler is deterministic: a template over the ledger, no LLM.
- The test runner is vitest (simpler with ESM and TS than jest in cue).
