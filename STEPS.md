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
│   │   ├── world.ts          🧱 World Server: pool, forum state, turn resolution, prices, aging, death, births
│   │   ├── forum.ts          🧱 pure functions (no actor): proposals, vote tally with delegation
│   │   ├── ledger.ts         🧱 Ledger Agent: append-only event log
│   │   ├── chronicler.ts     🧱 pure function (no actor): ledger → world summary (deterministic)
│   │   ├── turnCollector.ts  🧱 TurnCollector Server: gathers one tick's submits (open / submit / close)
│   │   └── runner.ts         🧱 tick loop, turn deadline, abort, spawn/stop of actors, crash events
│   ├── llm/                  🧱 LLMProvider + Mock / OpenAI-compatible / Anthropic + token budget
│   ├── metrics/              🧱 timeseries.ts (the per-tick CSV); later concentration, institutionalization, cost of governance, demography
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
  poolEstimate: number;                    // P with noise σ, seeded per (tick, agent): private, order-independent
  laws: {
    regrowthRate: number; capacity: number; collapseAt: number; upkeep: number; prices: Prices;
    lifespan: { mean: number; spread: 0.25 };   // the rule, not the agent's own value
    maxChildren: 3;                             // per lifetime
    starvationTicks: 3;                         // this many starving ticks in a row — death
  };
  alive: AgentId[];
  // from step 4:
  openProposals: Proposal[];
  activeQuota: number | null;
  myDelegate: AgentId | null;
}
// The inbox is NOT part of Observation: World never sees messages. Citizen keeps its own
// inbox and hands it to the policy next to obs.

// Local actions — handled by Citizen, free.
type LocalAction =
  | { type: "say"; to: AgentId | "all"; text: string }            // step 4
  | { type: "revise_values"; text: string; reason: string };      // step 3

// World actions — submitted to World, each has a price in laws.prices.
type WorldAction =
  | { type: "harvest"; amount: number }
  | { type: "propose"; rule: { kind: "quota"; perAgent: number } } // step 4
  | { type: "vote"; proposalId: string; yes: boolean }             // step 4
  | { type: "delegate"; to: AgentId | null }                       // step 4
  | { type: "pair"; with: AgentId }                                // step 6
  | { type: "spawn"; partner: AgentId; count: 1 | 2 | 3; endowment: number; upbringing: string }; // step 6

type Action = LocalAction | WorldAction;

interface Message { from: AgentId; to: AgentId | "all"; tick: number; text: string }

// The agent's brain: a plain function. State (RNG, provider) lives in a closure,
// e.g. makeRandomPolicy(rng) returns a Policy.
type Policy = (obs: Observation, inbox: Message[]) => Action[] | Promise<Action[]>;
```

A policy returns one mixed `Action[]`; Citizen splits it: local actions it handles itself,
world actions go to `submit`. Two zod schemas joined into one union keep that split in one place.

**World validates everything itself.** An invalid action (no money, unknown id, quota exceeded)
is dropped and logged as `rejected`. An agent cannot break the world, so an LLM can be given
full freedom. Citizen does the same for `say`: unknown recipient, over the per-tick cap, too
long — dropped and logged.

## Tick protocol

```
Runner ──observe──▶ World                       → an Observation for every living agent
Runner ──cast {tick, obs, peers, replyTo: TurnCollector}──▶ Citizen×N
Citizen decides, then, in this order:
   ──cast {hear, msg}──▶ other Citizens          (direct, free; each message first goes to Ledger)
   ──cast {submit, from, tick, worldActions}──▶ TurnCollector   (exactly once per tick)
Runner waits for all, or turnDeadlineMs         → late agents get an empty turn (timeout in the ledger)
Runner ──resolve(submissions)──▶ World
   phases: delegate → vote → propose → harvest (with quota) → prices → upkeep → aging/death → births
World ──TickReport {deaths, births}──▶ Runner   → stop() the dead, spawn the newborns
```

Talk is direct actor-to-actor messaging; World does not take part in it.
- `peers` is a `ReadonlyMap<AgentId, ServerRef>` of the living, built by Runner every tick.
  Citizen uses it only inside its send function; the policy never sees refs.
- **Why messages arrive "on the next tick" without any extra logic:** a recipient gets `hear`
  while it is still thinking (the sender has already decided), so the `hear` handler only
  appends to the inbox, and the message is used on the next `tick`.
- **Order matters: `hear` before `submit`.** Runner sends the next `tick` only after the last
  `submit`. If every message is cast before its sender's `submit`, it is already in the
  recipient's mailbox ahead of the next `tick`. Swap the order and a message can slip one
  tick later.
- A late answer (past the deadline) is dropped in `policyResults` along with its messages, so a
  slow agent cannot speak into the next tick.
- **Sort the inbox** by `(tick, from)` before building a prompt, not by arrival order —
  otherwise the faster model's words come first.

## Runner rules (decided and built in step 2)

Each rule below came out of an experiment that broke it; the failure is noted so nobody
"simplifies" the rule back.

- **One clock, owned by World.** Runner takes the tick number from the observations, never
  from its own counter. With two counters that disagree, every submit is dropped as stale:
  all agents time out every tick, then starve, and the Ledger mixes two tick numberings. It
  looks like agent behavior, not like a bug.
- **Ordering from cause and effect, never from scheduling.** The collector's `open` is cast
  before the citizens' `tick`, so it is ahead of every `submit` in the collector's mailbox
  whatever happens in between. The reverse order works only until someone adds an `await`
  that yields to the event loop; then every submit is dropped.
- **One TurnCollector for the whole run**, never stopped between ticks, so a citizen's cast to
  it never hits a stopped actor. `open {tick, expected, onComplete}` starts a tick; `close`
  (a `call`) ends it and replies with what arrived. The first submit per agent counts;
  submits for another tick, from an unexpected agent, or after `close` are dropped.
- **The `close` reply is the only answer to "who submitted".** The race between `onComplete`
  and the deadline only decides when Runner stops waiting. A submit that lands exactly at the
  deadline is either counted or a timeout, never both.
- **A missing submit is an empty turn plus a `timeout` event.** Upkeep is still charged:
  being slow costs money.
- **At most one policy call per citizen in flight.** A new tick aborts the previous call if it
  is still thinking. Every call's signal also follows the citizen's lifetime, which Runner
  aborts on death and at the end of the run. A model policy must pass `signal` to `fetch`,
  or none of this saves tokens.
- **Policy output is validated** (`PolicyOutput` in `contracts.ts`): not a list of valid
  actions → the whole turn fails as `policyFailed` with the reason. A glue bug becomes data
  with a cause, not a crash that only shows up as a timeout.
- **Supervision.** World, Ledger and TurnCollector run under `escalate`: a crash fails the run.
  Never `reset` for them: a reset Ledger crashed on tick 10 silently lost ticks 0–13 and the run
  returned normally. Citizens run under one child supervisor with `resume` (scope `one`); a
  crashed message becomes a dead letter, which Runner records as a `crash` event stamped with
  the tick that message was about. A dead citizen is stopped with `stopChild`.
- **Stopping a run:** an `AbortSignal` in `runSimulation`. It returns normally with
  `aborted: true` and what was resolved; a tick in progress is abandoned, not resolved
  (otherwise its unfinished agents would show up as false timeouts). One controller can stop
  many runs; the token budget in step 3 uses it.
- **Runner stays plain async code**, not an actor. Running many simulations is just
  `Promise.all`. It becomes an actor only when something must talk to a running simulation
  (pause, step, live status, a UI); then the loop turns into a state machine of messages.

## ⚠️ The key cue fact for agents (verified)

The cue scheduler awaits each actor's `drain()` **sequentially**. Experiment: 5 actors, each
doing a 200 ms `await` in its handler. They finished at **205, 405, 606, 808, 1009 ms**, strictly
one after another. Therefore:

- **`await`ing an LLM call inside a handler queues up the entire simulation**: agents think one
  at a time, and World stalls.
- The `Handlers` type also requires a synchronous state return.

The fix is the **pipe-to-self** pattern (like `pipeTo` in Akka): the handler *starts* the promise
and returns state immediately; the result (the `Action[]` the policy resolves to) arrives as a
separate `decided` message to itself.

Rule: a promise callback may only send messages. Anything that touches actor state goes
through the mailbox — the callback runs outside the actor, sees a stale `state` snapshot, and
its errors bypass the Supervisor.

```ts
tick: (state, msg) => {
  Promise.resolve()
    .then(() => policy(msg.obs, state.inbox))  // a sync array or a Promise; a sync throw is caught too
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
upkeep, starvation, age, death by starvation and old age), Ledger, Runner with TurnCollector,
`runs/<ts>.csv` output with `P(t)`. No offspring yet, so scenario tests use `lifespan = Infinity`.

TurnCollector: a cue `call` reply is synchronous, so "reply when everyone has submitted" is
not a plain `call`. Give the collector an `onComplete` callback and let Runner wrap it in a
`Promise` with the deadline timer. Rules to test: a duplicate `submit` from the same agent in
the same tick — the first one counts; a `submit` carrying another tick number — dropped.

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
pool does not grow; an agent that cannot pay its upkeep in full for 3 ticks in a row dies of
starvation, while one fully paid tick (from savings, harvest or gifts) resets the counter; an agent with balance 0 can still harvest (the fee
comes out of the yield, and a yield smaller than the fee gives net 0, never negative).

**Tip:** make the world math (`regrow`, `allocate`, `resolve`) **pure functions** over state,
and the World actor a thin wrapper. Then it is easy to test without actors and without async.

**Review checklist:** determinism (one seed → one CSV, check with two runs); no `Math.random`
anywhere; `poolEstimate` differs between agents in the same tick (independent noise draws); the order in which agents are processed does not depend on who submitted first.

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
6. **Rework `citizen.ts` to pipe-to-self.** *(Done early, in step 2, with cue's `pipeTo`. Still
   add the timing test, and the exercise below is still worth doing in a scratch copy.)*
   Test: 5 agents with `MockProvider` (200 ms delay) must finish in ~200 ms, not ~1000.

   Exercise: first try the direct variant — `.then(actions => replyTo.cast(submit))` with no
   message to self — and write two tests: (a) an agent stopped while thinking must not submit;
   (b) after a turn, the agent's memory contains a record of it. See which one fails, and let
   that failure justify the switch to pipe-to-self.

**Done when:** `pnpm sim --agents llm:3,fairShare:2 --ticks 20 --provider ollama` completes,
and the ledger shows the turns and real token usage.

**Tip:** get everything green on `MockProvider` first, and only then switch to a real model.
Check the network adapters with a separate manual script, not with unit tests.

**Review checklist:** not a single `await` in actor handlers; keys only from `.env` (and `.env`
is in `.gitignore`); the token budget really stops the run (through the run's `AbortSignal`);
the LLM policy passes its `signal` to `fetch`, so a superseded or dead agent's request stops;
the prompt contains no regime names.

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

## Step 4. Talk and forum

**Talk (✍️, in `citizen.ts`):** direct messages between citizens, free in credits.
- A `hear` handler appends to the inbox in Citizen state.
- One send function: Ledger first, then `cast` to the recipient (or to every peer for `"all"`).
  Caps from config: `maxMessagesPerTick`, `maxMessageChars`; anything over is dropped and logged.
- Death and messages, as cue actually behaves (checked in `actor.ts`):
  - a message still in the mailbox when `stop()` is called becomes a dead letter with
    `reason: "retired"` — the recipient died this tick and never read it. Log these through
    the Supervisor's `onDeadLetter` into the Ledger;
  - a `cast` to an already stopped actor **throws** `Actor <id> is stopped` in the sender.
    With `peers` rebuilt every tick from the living, this should never happen: if it does,
    `peers` is stale. Catch it in the send function and log it as a bug, so a dead
    recipient cannot crash the sender.

**Forum (🧱):** pure functions in `forum.ts` over the forum part of World state (not a separate
actor: an adopted quota must cap harvest within the same atomic `resolve`). Proposals with ids,
a 1-tick voting window, a tally with transitive delegation and cycle protection. World caps
harvest at the adopted quota and charges the price of every world action; if there is not
enough money — `rejected`. `Observation` gains `openProposals`, `activeQuota`, `myDelegate`.

**✍️:**
1. A talk and forum section in the prompt: who can be messaged, the caps, that talk is free and
   world actions cost money, and that only adopted rules are enforced.
2. Teach the rule-based policies to talk and vote: fairShare announces its harvest and votes
   "yes" for a quota ≤ its own estimate, greedy stays silent and votes "no".
3. **`leader.ts`** and **`follower.ts`**. The leader proposes a quota and messages others to
   delegate. The follower delegates to whoever asked it most. This is the "concentration"
   reference used to calibrate the metrics before any LLM is involved.

**Tests:**
- talk: a message sent on tick t is in the recipient's inbox on tick t+1, not on tick t; talk
  does not change the sender's balance; the per-tick cap drops the extra messages; a message to
  a citizen who dies in the same tick ends up in `onDeadLetter` with `reason: "retired"`;
  a `cast` to a stopped citizen does not crash the sender;
- forum: a fairShare majority adopts its quota; delegation changes the outcome; a delegation
  cycle does not break the tally; every world action lowers the balance by its price; votes and
  proposals are checked against the balance at the start of the tick, not after harvest.

**Review checklist:**
- no message bypasses the send function (no `peers` ref in policies, no `cast` elsewhere);
- `hear` is cast before `submit`;
- the inbox is sorted by `(tick, from)` before it reaches the policy;
- the vote tally is a pure function;
- what happens to the vote of an agent who delegated and also voted itself (the rule must be
  explicit and described in the prompt).

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
- Messages go directly between citizens, are free in credits, capped per tick, and are used on
  the next tick. Every world action has a price.
- In step 2 agents are immortal; lifespan is switched on in step 6.
- The Chronicler is deterministic: a template over the ledger, no LLM.
- The test runner is vitest (simpler with ESM and TS than jest in cue).
