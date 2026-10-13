# Syncw

**Synchronized World** — a declarative orchestration layer where **agent behaviour, provider access, and model capability are three orthogonal, hot-swappable registries.**

You write who does what and under which policy. Syncw resolves *which model* at runtime, records why, and lets you replay the whole run on different models and see exactly what changed.

> ### 📐 Where this is going
>
> M0 (everything in this README, runnable today) treats an "agent" as a *prompt + output contract* executed as one model call.
>
> The target architecture treats an "agent" as **an existing agent application** — Codex CLI, Claude Code — driven as a long-running session, with a planner in one and an executor in the other.
>
> That design is written up in **[docs/AGENT-MESH.md](docs/AGENT-MESH.md)**: a driver layer that survives minor CLI updates (capability contract + fingerprint drift detection + conformance probe), coordination over git/issue/chat rather than a bespoke scheduler, and a `TaskPackage` / `RunResult` handoff protocol.
>
> It also documents, honestly, which parts of M0 **do not survive** the change — most notably the content-addressed cache, which is unsound when a "call" mutates a filesystem.

```yaml
- id: implement
  agent: implementer              # behaviour — contains no model
  bind:                           # a query over model space, not an assignment
    require: [json_schema, ctx>=128k, quality>=0.80]
    prefer: cost
    escalate_if: { retries: 1, to: quality }
```

```yaml
- id: verify
  agent: verifier
  bind:
    require:
      - json_schema
      - not_family_of:$.nodes.implement.actual_model   # different lineage than the author
    prefer: quality
```

Nothing above names a model. The second example constrains against **whatever the implementer actually ran on**, which stays correct even when that was chosen at runtime by a cost policy — or changed mid-run by an escalation.

---

## Quick start

Requires Node ≥ 22.18 (native TypeScript — no build step).

```bash
npm install
npm run demo        # end-to-end story, no API keys, 7 self-checks
npm run verify      # typecheck + 75 tests + demo
```

**No API keys needed.** With no credentials present, Syncw routes every model through an offline synthesiser and tells you it did. The capability registry, binding policy, caching, replay and diff all behave identically — only the wire is substituted.

```bash
node src/cli.ts run feature-dev      # six nodes, plan → research → judge → gate → implement → verify
node src/cli.ts bind feature-dev --explain   # resolve every binding without calling anything
```

The test suite covers the parts that are easy to get subtly wrong: merge semantics and ownership enforcement, the safety/resource constraint split, fallback refuse-to-violate behaviour, the retry → fallback → escalate ordering, join arithmetic under partial failure, and cache accounting.

---

## The command worth learning

```bash
node src/cli.ts replay <runId> --swap research=openai/gpt-5
```

Swap **one** node's model, re-run, and diff. Untouched nodes are served byte-identically from the content-addressed cache, so the diff isolates your change.

Here is the real output of that command:

```
  node         model                                                B source  cost A   cost B   Δcost
  = plan       anthropic/claude-opus-4-1                            cached    $0.0229  $0.0000  -$0.0229
  ~ research   anthropic/claude-sonnet-4-5 → openai/gpt-5           cached    $0.0121  $0.0060  -$0.0062
  ~ judge      deepseek/deepseek-v3-2 → anthropic/claude-opus-4-1   live      $0.0003  $0.0154  +$0.0151
  ~ implement  deepseek/deepseek-v3-2                               live      $0.0002  $0.0002  =
  ~ verify     anthropic/claude-opus-4-1                            live      $0.0146  $0.0130  -$0.0016

  total                                       $0.0500 → $0.0345   -31%   ← not comparable
  like-for-like, over the 3 nodes that made a live call in B:
                                              $0.0150 → $0.0286   +91%
```

You changed `research`. **`judge` re-bound itself** — because `research`'s `actual_families` collapsed from `{claude, gpt, gemini}` to `{gpt}`, so Claude became the highest-quality model outside the producers' lineage. A node nobody edited got **59× more expensive**, its confidence fell from 0.84 to 0.59, which fired a human gate that had previously been skipped, and the verdict flipped from `passed: false` to `passed: true`.

And note the two totals. Cached nodes cost nothing, so the bottom line *fell* 31% while the work that actually ran got **91% more expensive**. Read the bottom line and you conclude the opposite of the truth.

> In a cross-model pipeline you cannot reason about cost or behaviour node by node.
> The chronicle is the only thing that tells you the truth.

Run `npm run demo` to reproduce this end to end, with an automated verdict at the end.

---

## Commands

| | |
|---|---|
| `syncw models` | the model capability registry |
| `syncw providers` | which providers this machine can actually reach |
| `syncw bind <workflow> [--explain]` | resolve every binding **without calling a model** |
| `syncw run <workflow>` | execute |
| `syncw runs` / `show <runId>` | run history and summaries |
| `syncw explain <runId> [--explain]` | every binding decision that run made, candidates included |
| `syncw replay <runId> [--set node=model]` | re-run the same inputs on different models |
| `syncw diff <runA> <runB>` | node-by-node comparison |

Useful flags: `--input k=v`, `--offline`, `--all-providers`, `--fresh`, `--yes`, `--mock-fail '<glob>'`.

---

## Repository layout

```
agents/       behaviour specs — model-free by construction
models/       capability profiles (ctx, caps, cost, latency, quality prior)
providers/    endpoints + credentials
workflows/    the DSL: topology + binding policy + world schema
runs/         the chronicle (gitignored)
src/
  schema/     types + YAML loading/validation
  runtime/
    binding.ts       the binding policy engine  <- the core
    requirements.ts  the constraint language (safety vs resource)
    world.ts         shared state + merge semantics
    engine.ts        DAG scheduler, fan-out, join, budget, recovery
    cache.ts         content-addressed call cache
    trace.ts         the chronicle
  providers/  mock (offline) + openai-compat
  report.ts   binding plans, run summaries, replay diff
docs/DESIGN.md   full design document — read this next
```

---

## Using real models

Set a key and Syncw uses it automatically; `syncw providers` shows the routing.

```bash
export DEEPSEEK_API_KEY=...     # or OPENAI_API_KEY / GEMINI_API_KEY / OPENROUTER_API_KEY
node src/cli.ts providers
```

Anthropic's native API is not OpenAI-shaped, and Syncw deliberately does **not** ship a second adapter for it — front it with a translation gateway and point `base_url` at that. See `providers/anthropic.yaml`.

---

## What this is not

- Not a provider gateway. That problem is solved (LiteLLM, OpenRouter); Syncw owns selection and orchestration. Tools go through MCP, cross-process agents through A2A.
- Not a visual builder. The DSL is the source of truth; a UI would be a projection of it.
- Not a code-first graph library. Orchestration is **data** — that is precisely what makes replay, diff, and (next) self-tuning routing possible.

**M0 status:** the engine, world state, binding policy, chronicle, cache and replay/diff are implemented and runnable. Evaluation-driven routing is the next milestone — see [docs/DESIGN.md](docs/DESIGN.md) §9.
