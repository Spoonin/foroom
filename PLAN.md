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

The pricing rule: **talking is free, acting on the world costs money.**
- Messages between citizens go directly from actor to actor and cost nothing in credits.
- Every action submitted to World (harvest, proposal, vote, delegation, birth) has a fixed price.

So informal agreement is free, while formal institutions cost money:

| Regime | Cost in credits | Decision quality |
|---|---|---|
| Anarchy | nobody pays: there are only spoken agreements, and nothing enforces them | the pool is held only by trust → usually depleted |
| Democracy | everyone pays for proposals and votes, on every proposal — expensive | aggregates distributed information; the world enforces the decision |
| Authoritarianism | the leader pays for proposals; the others pay once for delegation — cheap | depends on the leader's information and motives |

Prices are experiment parameters: "how expensive democracy is" becomes a knob rather than a
side effect of model verbosity. The interesting question is whether free talk is enough to
hold the pool, or whether agents start paying for enforceable rules.

Free talk still needs a bound that is not in credits, or it costs tokens and lets the most
talkative agent fill everyone else's prompt: at most `maxMessagesPerTick` messages per agent
per tick, each at most `maxMessageChars` long. Equal volume means equal voice.

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

- **Credits are whole numbers.** The world floors every amount it computes (shares, growth), and
  actions may only carry whole amounts. To keep rounding negligible, everything is scaled ×100,
  like cents: `K = 100 000`, upkeep 100, a vote 100. Leftovers from flooring stay in the pool.
- **Common pool** `P` (credits), logistic regrowth: `P += floor(r·P·(1 − P/K))`.
  Below `collapseAt` regrowth switches off permanently → collapse.
- **Tick**: every agent declares how much it takes from the pool (`harvest`). At most
  `maxHarvestFraction · P` (default ½) can be taken in one tick by all agents together, so the
  pool cannot be emptied in a single tick. If the total demand exceeds that cap, the cap is split
  in proportion to demand.
- **Upkeep**: every tick `upkeep` credits are charged to each agent. If the balance is
  insufficient, it is zeroed and the agent **starves**. The hunger counter grows every tick
  until the balance is replenished; any income (harvest, later transfers) resets it.
  **3 ticks in a row without income — death.** A starving agent acts normally (it can harvest
  and save itself) and sees its counter in its observation.
- **Information noise**: agents see `P` with noise `σ`; nobody knows the exact value.
  The noise is drawn **independently per agent, per tick**: each estimate has its own seed,
  `deriveSeed(runSeed, "noise:<tick>:<agent>")`, so every agent has its own private estimate and
  the result depends on nothing but (run seed, tick, agent). That is what makes information worth pooling: the mean of `n`
  independent estimates has noise `σ/√n`, so talking and voting have a measurable value, and
  an agent can misreport its estimate to persuade others. One shared estimate would leave
  nothing to pool or argue about.

## Agent action primitives (v0)

Actions come in two kinds: **local** actions are handled by the Citizen itself and are free;
**world** actions are submitted to World and each has a price. Prices are config parameters.

| Action | Kind | Price |
|---|---|---|
| `say(to \| "all", text)` — a direct message to one citizen or to all living | local | 0 (capped by `maxMessagesPerTick`, `maxMessageChars`) |
| `revise_values(text, reason)` — revise your own values | local | 0 |
| `harvest(amount)` | world | `c_harvest` (small fee, taken **from the yield**: net = got − min(c_harvest, got)) |
| `propose(rule)` — one rule kind for now: per-agent harvest quota | world | `c_propose` |
| `vote(proposalId, yes\|no)` | world | `c_vote` |
| `delegate(to \| null)` — hand your vote to someone else (transitive, stays in force) | world | `c_delegate` (paid once, not per proposal) |
| `pair(with)` + `spawn(count ≤ 3, endowment)` — offspring (step 6) | world | `c_pair`, `c_spawn` + `endowment` |

An adopted quota is enforced by the world automatically (sanctions come later). A spoken
promise is enforced by nothing; that difference is the point of the experiment.

**No death trap at zero.** Harvest is the only way out of starvation, so it must stay possible
with an empty balance: its fee is never paid in advance, only deducted from what was actually
taken, and never makes the net negative. "Income" for the hunger counter means net > 0.
The other world actions are paid from the balance at the start of the tick: an agent cannot
vote with credits it has not harvested yet. A broke agent can still harvest and talk.

## Regime metrics

Computed from the `Ledger` every tick:
- **Power concentration** — HHI over agents' "decision weight" (own vote + delegated votes +
  authorship of adopted rules).
- **Institutionalization** — share of ticks with an adopted rule in force, and share of agents
  who voted.
- **Cost of governance** — credits spent on `propose/vote/delegate` relative to harvest.
- **Informal coordination** — messages per tick, share of messages that name a number
  (a proposed harvest), and how often agents harvest what they said they would. This is the
  free channel that the cost of governance does not see.
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
Supervisor (root)
├── World          Server — pool, forum state, turn resolution, quota enforcement
├── Ledger         Agent  — append-only event log (source of all metrics)
├── TurnCollector  Actor  — collects submits for the current tick, calls onComplete
└── Supervisor (citizens, scope: "one", policy: "resume")
    └── Citizen×N  Server — agent policy (rule-based or LLM) + personal log + values + inbox
                   Citizen ──hear──▶ Citizen   (direct, free; a copy goes to Ledger)

Plain modules (no actor):
  forum.ts       — pure functions over World's forum state: proposals, tally, delegation
  chronicler.ts  — pure function: ledger → world summary text, called once per tick
  runner.ts      — async tick loop; holds citizen refs in a Map<AgentId, ServerRef>
```

Rule of thumb: an actor is warranted where there is state of its own that changes over time
and is accessed from outside. Stateless logic stays a function.

- **Resources go through World, talk goes directly.** The shared pool needs one owner and an
  atomic `resolve`. Messages need neither: a citizen sends `hear` straight to another citizen's
  mailbox. This is where the actor properties are exercised: isolated state (nobody sees
  another's inbox), buffering in the mailbox while the recipient is thinking, and dead letters
  (`reason: "retired"`) for messages the recipient never read because it died that tick.
- **Lockstep still holds for talk.** All citizens get `tick` at the same time and start
  thinking. A message is sent only after its sender has decided, so it lands in the
  recipient's inbox while the recipient is thinking, and is used on the next tick. Delivery on
  the next tick comes from the mailbox itself, not from World.
- **Talk stays observable.** Sending goes through one function in `citizen.ts` that writes the
  message to the Ledger and then casts `hear`. A policy only returns `say` actions; it never
  holds a ref to another citizen.
- **Forum is part of World, not a separate actor.** An adopted quota must cap harvest within
  the same tick, and `resolve` is atomic inside World. A separate Forum actor would force
  World to wait on another actor in the middle of `resolve`.
- **The Chronicler has no state of its own**, so it is a function, not an actor.
- **TurnCollector**: a cue `call` reply is returned synchronously from the handler, so "reply
  once everyone has submitted" cannot be a plain `call`. The collector is given an `onComplete`
  callback; Runner wraps it in a `Promise` with the turn-deadline timer.
- **No `Registry`**: Runner keeps strong refs in a `Map`; `Registry` holds `WeakRef`s and could
  silently lose an agent after GC.

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

4. **Talk and forum (~1.5 h).** Free direct `say` between citizens; paid `propose(quota)`,
   `vote`, `delegate`; World enforces the adopted quota.
   *Done when:* the log shows message → proposal → vote → quota in force, balances drop by the
   prices of world actions only, and a message to a citizen who died that tick shows up as a dead letter.

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
- **Real-time talk**: a citizen may answer a message mid-tick with a separate short model call,
  so a dialogue happens within one tick. This brings back the advantage of fast models, so it is
  a separate experimental condition ("one message round per tick" vs. "real-time talk").
- **Paid talk**: a condition with `c_say > 0` — does making talk expensive push agents toward
  formal rules or toward silence?

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
- Talking is free and goes directly between citizens (capped per tick); every action submitted
  to World is paid.
- Credits are integers, scaled ×100; the world floors, and fractional amounts in actions are rejected.
- An agent formulates its values itself at birth, based on the world picture and its upbringing,
  and **revises them along the way** via the `revise_values` action on a normal turn.
- An agent that misses the turn deadline loses its turn: no actions, but upkeep is still charged.
  A slow model is a real handicap in this world, not something the runner waits out.
- Each agent has at most one model call in flight: a new tick cancels a call that is still
  thinking, and death or the end of the run cancels it too.
- An agent's broken output (invalid actions) is an empty turn, recorded with its reason. A failure
  is data for the experiment, never a crash of the run.
