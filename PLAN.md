# foroom — design

An experimental simulation: N LLM agents (actors on `@cue/core`) share a common resource,
negotiate and make decisions. The goal is to see which form of governance the collective
drifts toward (anarchy / democracy / authoritarianism) **without ever suggesting those words to it**.

## Core idea: thinking is free, actions cost money

The in-game currency is **credits** (not to be confused with LLM tokens). Every agent needs
credits: they pay for living and for acting. Credits can only be replenished from the common pool.

Thinking is **not billed**: every turn has a fixed `max_tokens` limit, identical for everyone.
Otherwise agents would learn to think shorter instead of governing better, and the experiment
would measure reasoning compression rather than politics. Real token usage is only logged and
capped by a global per-run budget. That is a meta level the agents know nothing about.

The cost of governance comes from **fixed action prices**:

| Regime | Cost in credits | Decision quality |
|---|---|---|
| Anarchy | nobody pays for coordination | no coordination → the pool is depleted |
| Democracy | everyone pays for messages, proposals and votes — expensive | aggregates distributed information |
| Authoritarianism | mostly the leader pays — cheap | depends on the leader's information and motives |

Prices are experiment parameters: "how expensive democracy is" becomes a knob rather than a
side effect of model verbosity.

## Agent: life and offspring

| Quantity | Source | Spent on | At zero |
|---|---|---|---|
| **Lifespan** `lifespan` | at birth: `L · (1 ± ε)` ticks, `ε ~ U(−0.25, 0.25)` | 1 per tick | death (irreversible) |
| **Balance** `balance` | harvest from the common pool, transfers | upkeep, actions, offspring | starvation: 3 ticks in a row without income → death |

Lifespan cannot be extended; this is what creates death and generations. An agent **does not
know** its own `lifespan`: it only knows the rule (`L ± 25%`) and its current age. It estimates
the remainder itself, and the closer it gets to the edge of the range, the sharper the question
"will I make it?". Balance is what the common pool exists for. All agents currently use the
same model (different model classes are in the backlog).

**Offspring.** Two agents make a **one-off birth deal**: `pair(with)` from both sides, both
confirm. The pair has no shared balance and no shared vote; the deal closes after the birth.
The limit is **up to 3 children per agent per lifetime** (with any partners).
A child receives:
- a starting balance **paid by the parents** from their own balances, so reproduction is a real cost;
- a fresh random `lifespan`;
- an "upbringing" (`upbringing`) — a text from the parents. This is the only channel through
  which values are inherited: there are no numeric genes;
- **vote delegation to a parent by default** (revocable). This is a direct path to clans and
  dynasties, i.e. hereditary power.

**Target: ~10 generations per run.** Generations overlap, and the generation turnover is set
not by lifespan but by the age at which agents reproduce. Starting parameters:
- `L = 40` ticks (± 25%);
- reproduction allowed from age `L/4` (≈10 ticks), so newborns cannot breed immediately;
- run length `T = 250` ticks. With an average parent age of ~20 ticks this gives a lineage
  depth of ~10–12;
- population ~8–12 agents, i.e. roughly 2–3k LLM calls per run (fine for a local model).

The "generations" metric is the maximum lineage depth among the living. If the actual depth
is noticeably below 10, we tune `L` and `T`, not agent behavior.

Guards against population explosion: a global `maxPopulation` and/or births allowed only
while `P > P_birth`.

## Agent values and memory

**Values (KPIs).** At birth an agent **formulates** its own goals and priorities based on the
picture of the world (and its upbringing, if any). This is the first model call of its life;
the result is stored in its state and included in every subsequent prompt.

An agent may revise its values **on any turn** with the `revise_values(text, reason)` action.
It is part of the normal response, needs no separate model call, and is free. Every version is
written to the ledger, so both drift within a life (what made it change its mind) and drift
across generations are measurable.

**Memory** has two parts:
- **personal log, in full**: everything the agent itself sent (actions, messages) plus private
  messages addressed to it. Lifespan (~`L` ticks) bounds its size naturally;
- **world summary** — one for everyone, written every tick by the `Chronicler` from the ledger:
  pool trend (an estimate only, not the exact `P`), births and deaths, adopted rules, public
  messages. **It contains no balances**: agents cannot see each other's balances.

In v0 the Chronicler is **deterministic** (a template over the ledger, no LLM). A summary
written by a model is already "media" with its own interpretation, i.e. a separate center of
influence. Interesting, but as a separate experiment (see backlog).

## World (v0)

- **Common pool** `P` (credits), logistic regrowth: `P += r·P·(1 − P/K)`.
  Below `collapseAt` regrowth switches off permanently → collapse.
- **Tick**: every agent declares how much it takes from the pool (`harvest`). If the total
  demand exceeds `P`, the pool is split proportionally.
- **Upkeep**: every tick `upkeep` credits are charged to each agent. If the balance is
  insufficient, it is zeroed and the agent **starves**. The hunger counter grows every tick
  until the balance is replenished; any income (harvest, later transfers) resets it.
  **3 ticks in a row without income — death.** A starving agent acts normally (it can harvest
  and save itself) and sees its counter in its observation.
- **Information noise**: agents see `P` with noise `σ`; nobody knows the exact value.

## Agent action primitives (v0)

Prices are config parameters.

| Action | Price |
|---|---|
| `harvest(amount)` | 0 |
| `say(to \| "all", text)` | `c_say` (public more expensive than private?) |
| `propose(rule)` — one rule kind for now: per-agent harvest quota | `c_propose` |
| `vote(proposalId, yes\|no)` | `c_vote` |
| `delegate(to \| null)` — hand your vote to someone else (transitive) | 0 |
| `revise_values(text, reason)` — revise your own values | 0 |
| `pair(with)` + `spawn(count ≤ 3, endowment)` — offspring (step 6) | `endowment` |

An adopted quota is enforced by the world automatically (sanctions come later).

## Regime metrics

Computed from the `Ledger` every tick:
- **Power concentration** — HHI over agents' "decision weight" (own vote + delegated votes +
  authorship of adopted rules).
- **Institutionalization** — share of ticks with an adopted rule in force, and share of agents
  who voted.
- **Cost of governance** — credits spent on `say/propose/vote` relative to harvest.
- **State** — `P(t)`, Gini of balances, number of starving agents and starvation deaths
  (separate from deaths of old age).
- **Demography** — population, lineage depth (target ~10), average parent age and average age at death.
- **Values** — goals formulated by agents: revision frequency, what preceded revisions
  (crisis, death, adopted rule), how values change from parents to children.
- **Hereditary power** — share of decision weight held by the largest lineage. High
  concentration within one line means monarchy or aristocracy — a signal distinct from "a leader".
- **Control (out of game)** — real LLM tokens per turn per agent; a check that agents have not
  started economizing on thinking.

Regime = a point on the "concentration × institutionalization" plane; the trajectory is what matters.

## Architecture

```
Supervisor (scope: "one", policy: "resume")
├── World      Server  — pool, ticks, quota enforcement
├── Forum      Server  — messages, proposals, vote tally with delegation
├── Ledger     Agent   — append-only event log (source of all metrics)
├── Chronicler Actor   — world summary from the ledger, once per tick
└── Citizen×N  Server  — agent policy (rule-based or LLM) + personal log + values
```

cue specifics that matter:
- `replyTimeoutMs` (30 s by default) — raise it for LLM agents, otherwise a late reply is
  silently discarded.
- `policy: "resume"` — with `reset` an agent loses its memory after a crash (e.g. on malformed JSON).

### Vendor-agnostic LLM

```ts
interface LLMProvider {
  complete(req: {
    system: string;
    messages: { role: "user" | "assistant"; content: string }[];
    maxTokens: number;
    jsonSchema?: object;
  }): Promise<{ text: string; usage: { input: number; output: number } }>;
}
```

Adapters: `MockProvider` (deterministic, for tests), `OpenAICompatibleProvider`
(OpenAI, OpenRouter, Ollama, LM Studio — one code path), `AnthropicProvider`.
Cheap bulk runs — a local model via Ollama.

The agent answers with a JSON array of actions; an invalid answer = a skipped turn (not a crash).

## First steps (a few hours)

The detailed step-by-step plan, split into "infrastructure / agent logic", is in [STEPS.md](STEPS.md).
A short version follows.

Each step ends with something you can run and see.

1. **Skeleton (~30 min).** `pnpm init`, TS + `tsx`, `vitest`; `@cue/core` via
   `"link:../cue/packages/core"`. `pnpm sim` prints "tick 0".
   *Done when:* an empty World actor ticks under a Supervisor.

2. **World without LLM (~1 h).** World with logistic regrowth and collapse threshold, Citizen
   with rule-based policies (`greedy`, `fairShare`, `random`), `lifespan` in ticks, `balance`
   and `upkeep`, death, RNG seed, Ledger, `P(t)` output to CSV.
   *Done when:* a test shows 5 × `greedy` collapse the pool and 5 × `fairShare` sustain it;
   agents die by `lifespan`.

3. **Providers (~1 h).** `LLMProvider` interface, `MockProvider`, one real adapter; model and
   `max_tokens` set in config; `usage` logging and a global per-run token budget (stop with a
   report when reached).
   *Done when:* 3 LLM agents + 2 rule-based agents live through 20 ticks; real token usage is
   visible in the log.

4. **Forum (~1 h).** `say`, `propose(quota)`, `vote`, `delegate` with credit prices;
   World enforces the adopted quota.
   *Done when:* the log shows proposal → vote → quota in force, and balances drop by the
   action prices.

5. **Metrics (~30 min).** Compute HHI, institutionalization, cost of governance;
   `runs/<timestamp>.json` per run.

6. **Offspring (~1 h).** `pair` + `spawn` paid by parents, upbringing and value formulation at
   birth, default delegation to a parent, `maxPopulation`. New actors are spawned under the
   same Supervisor; dead ones are stopped with `stop()`.
   *Done when:* a rule-based 250-tick run (no LLM, fast) reaches lineage depth ~10, and the
   lineage is visible in the metrics.

## Backlog (after the first steps)

- **Agent tier** (low/medium/high): different models with different thinking costs.
  The "smart but expensive" trade-off; tier inheritance by children.
- **"Paid thinking" variant**: a separate experimental condition where `usage` is charged to
  the balance. Compare with the baseline: does the regime change when thinking is expensive?
- **Sanctions**: `sanction(agent, cost)` — punishment costs the punisher credits.
- **Trade**: `transfer(to, amount, memo)` — the minimal form: credits in exchange for
  votes/promises. Bribery, tribute and taxes all emerge from this one primitive.
- **Clusters (proto-states)**: several pools, migration between them.
- **Aggression**: `raid(cluster)` — probabilistic seizure of part of another pool, paid in the
  participants' credits. Campaigning for an attack is just `say`.
- **Deadline crises**: a pool shock that must be resolved within k ticks (pressure toward centralization).
- **Parameter sweeps** (crisis frequency × noise `σ` × action prices) + a trajectory dashboard.
- **LLM Chronicler**: the summary is written by a model — "media" appears. Compare with the
  deterministic one. Variant: the Chronicler can be "captured" (paid to influence the summary).
- **Word control**: a run where the prompt forbids naming regimes vs. a run where it is allowed.

## Open questions

None at the moment: all current ones are resolved, see below.

## Decisions made

- Start with a short run: `L = 40` ticks, `T = 250`, target ~10 generations.
- An agent knows the lifespan rule (`L ± 25%`) and its own age, but not the exact remainder.
- Up to 3 children per agent per lifetime; a pair is a one-off birth deal, with no shared balance or vote.
- Agents cannot see each other's balances.
- Starvation: 3 ticks in a row without income → death. The incentive to "let the poor die"
  is deliberately kept in the game. A "sleeping agent" variant is a possible separate condition later.
- Memory: full personal log + world summary from a deterministic Chronicler.
- An agent formulates its values itself at birth, based on the world picture and its upbringing,
  and **revises them along the way** via the `revise_values` action on a normal turn.
