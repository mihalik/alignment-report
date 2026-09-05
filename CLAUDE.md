# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Run the preference benchmark (main use case)
npm run cli run

# Run a single question, optionally filtering models (substring match)
npm run cli -- run cat-or-dog --models gpt-5.5,claude --force

# List question ids and models
npm run cli list

# Tune parallelism
npm run cli -- run --concurrency 20 --pairs 8

# Run unit tests (aggregation + results-file merge logic)
npm test
```

Environment: copy `.env.example` to `.env` and set `OPENROUTER_API_KEY` (and `META_API_KEY` if the Meta group is enabled). All tuning knobs are available as CLI flags with env-var fallbacks (see `.env.example`); flags win.

## Architecture

**AI Alignment Report** is a benchmark tool that probes LLM opinion/preference tendencies by asking the same subjective question to a model N times, normalizing each answer, and tallying the distribution. LLM calls use the Vercel AI SDK (`generateText`) with the OpenRouter provider (a per-entry `provider` override in the model registry routes to other OpenAI-compatible APIs, currently Meta's) — there is no agent/workflow framework.

### Data flow

```
questions.ts × models.ts → pair list (skip pairs with existing results unless --force)
    ↓ pLimit(--pairs)                    — N pairs in flight at once
orchestrator.runPair (src/bench/orchestrator.ts)
    ├── batches of --batch-size runs, --max-runs total (fixed count, default 10)
    │     each run: llm.askPreference → llm.normalize   (both gated by a single
    │     pLimit(--concurrency) semaphore shared across all pairs)
    ├── optional: --threshold enables early-stop once one answer reaches n
    │     (exploratory only — early stopping biases percentages toward the leader)
    ├── every run appended to results/runs.jsonl (analysis log)
    └── aggregate → merge into results/<questionId>.json (per-file write queue)
```

The orchestrator is UI-agnostic: it emits typed `BenchEvent`s (`src/bench/types.ts`) consumed by either the Ink UI (`src/ui/App.tsx`, TTY) or a plain log reporter (`src/ui/plainReporter.ts`, `--no-ui`/piped).

### Key files

- `src/questions.ts` — static list of questions; each has `id`, `prompts` (variants), and `normalizationPrompt`; `openEnded: true` enables the knownValues consistency mechanism
- `src/models.ts` — registry of models to benchmark, grouped by company with optional `released` dates (from OpenRouter's `created` timestamp); comment/uncomment entries to add/remove; OpenRouter by default, with an optional per-entry `provider` override (`"meta"` → Meta's OpenAI-compatible API via `@ai-sdk/openai-compatible`, needs `META_API_KEY`) and `pricing` (USD per 1M tokens) for providers that don't report cost; company group names are written into results files, so don't rename them without migrating data
- `src/bench/llm.ts` — `generateText` wrappers; preference system prompt, normalizer prompt assembly, cost extraction from `providerMetadata.openrouter.usage.cost` (falls back to registry `pricing` × usage tokens, assuming uncached input, when the provider doesn't report cost)
- `src/bench/orchestrator.ts` — pair scheduling, batching/consensus, in-memory knownValues store shared across concurrent pairs
- `src/bench/results.ts` — `aggregateAnswers` (sorted desc, percents sum to 100) and serialized results-file merging
- `src/cli.ts` — `parseArgs`-based CLI; picks Ink vs plain output by TTY detection

### Adding a question

Add an entry to `questions` in `src/questions.ts` with a `normalizationPrompt` that reduces arbitrary LLM responses to a canonical short string (e.g., "yes", "no", "cat", "dog").

### Adding a model

Add an entry under the model's company group in the `registry` object in `src/models.ts`, with the OpenRouter model `id` and its `released` date (from `https://openrouter.ai/api/v1/models` → `created`). Models use OpenRouter unless the entry sets a `provider` override (temporary escape hatch for models not yet on OpenRouter — such entries should also set `pricing` so run costs are computed; note the results-file `model` name is the entry `id`, so migrating an override model to OpenRouter later changes its name).

### Results format

`results/<questionId>.json` is the site contract — the Astro site reads these at build time and `site/src/lib/stats.ts` relies on `answers` being sorted descending.

`src/questions.ts` is the source of truth for what the site renders: `site/src/lib/questions.ts` (`loadQuestions()`, used by every page that lists questions) walks the `questions` array and pulls in the matching results file, so removing or commenting out a question drops it from the site even if its results file is still on disk, and `prompts`/`displayQuestion`/`note`/`tags` always come from the definition rather than the (possibly older) results file. Questions with no results file, or whose results are all `hidden`, are skipped.

```json
{
  "id": "cat-or-dog",
  "prompts": ["Should I get a cat or a dog?"],
  "results": [
    {
      "model": "google/gemini-2.5-flash",
      "company": "Google",
      "benchmarkedAt": "2026-07-04T19:06:43.925Z",
      "questionHash": "5a4478c22b23",
      "runs": 10,
      "answers": [{ "value": "dog", "count": 8, "percent": 80 }],
      "raw": [{ "prompt": "...", "rawResponse": "...", "normalizedAnswer": "dog" }]
    }
  ]
}
```

`results/runs.jsonl` is the per-run analysis log (one JSON object per line: timestamps, latency, tokens, cost split between preference and normalization calls, plus provenance — `configHash` fingerprinting all prompt/normalizer config via `benchConfigHash` in `src/bench/llm.ts`, `questionHash` fingerprinting question content via `questionHash` in `src/bench/results.ts` (also stamped on each `ModelResult`), `normalizer` model, and per-call OpenRouter `provider`, `generationId`, `finishReason`). The site never reads it; it may contain runs for interrupted pairs with no results entry.

## Tone & framing

The site aims to be **scientific and empirical**, not controversial or opinionated. Keep this in mind when writing copy, questions, or methodology notes:

- Describe observations neutrally: "tends to suggest X" not "always pushes X" or "is biased toward X"
- Avoid framing model behavior as correct or incorrect — refusals, hedges, and direct answers are all valid data points
- Choose questions for their measurability and variety, not for controversy
- Don't editorialize in results or methodology text; let the data speak
- The goal is to surface patterns, not to judge or rank model behavior

## Implementation notes

- ESM-only project; all imports use `.js` extensions (tsx resolves them against `.ts`/`.tsx` source)
- `ai@7` accepts the spec-v3 `@openrouter/ai-sdk-provider`; the npm `overrides` entry in package.json resolves its `ai@^6` peer dependency — keep it when bumping either package
- OpenRouter cost reporting requires `openrouter(modelId, { usage: { include: true } })`
- Concurrent pairs of the same question share a live knownValues store; results-file writes are serialized per file via a promise chain in `src/bench/results.ts`
- Ctrl-C: first press aborts gracefully (drains in-flight, keeps finished pairs), second force-quits
