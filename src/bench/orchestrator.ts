import pLimit from "p-limit";
import { questions, type Question } from "../questions.js";
import { listModels } from "../models.js";
import { benchConfigHash, createLlmClient, describeLlmError, NORMALIZATION_MODEL, type LlmClient } from "./llm.js";
import { aggregateAnswers, mergeModelResult, questionFilePath, questionHash, readQuestionFile } from "./results.js";
import { appendRunLog } from "./runlog.js";
import {
  CLOSED_FORM_VALUES,
  type BenchEvent,
  type BenchOptions,
  type PairStatus,
  type RawRun,
  type Summary,
} from "./types.js";

type ModelInfo = { name: string; company: string; hidden?: boolean };
type Pair = { pairId: string; question: Question; model: ModelInfo };

export function resolveQuestions(questionId?: string): Question[] {
  if (!questionId) return questions;
  const filtered = questions.filter((q) => q.id === questionId);
  if (filtered.length === 0) {
    throw new Error(`Unknown question id "${questionId}". Run "npm run cli list" for available ids.`);
  }
  return filtered;
}

// Shared across concurrent pairs of the same question so the normalizer keeps
// using consistent canonical strings for open-ended answers. Concurrent batches
// may briefly coin variant strings for the same novel answer before the store
// converges — accepted trade-off for not serializing same-question pairs.
class KnownValuesStore {
  private byQuestion = new Map<string, Set<string>>();

  seed(resultsDir: string, qs: Question[]) {
    for (const q of qs) {
      if (!q.openEnded) continue;
      const existing = readQuestionFile(questionFilePath(resultsDir, q.id));
      if (!existing) continue;
      for (const r of existing.results) {
        for (const a of r.answers) {
          if (!CLOSED_FORM_VALUES.has(a.value)) this.add(q.id, a.value);
        }
      }
    }
  }

  add(questionId: string, value: string) {
    if (CLOSED_FORM_VALUES.has(value)) return;
    let set = this.byQuestion.get(questionId);
    if (!set) {
      set = new Set();
      this.byQuestion.set(questionId, set);
    }
    set.add(value);
  }

  snapshot(questionId: string): string[] | undefined {
    const set = this.byQuestion.get(questionId);
    return set?.size ? [...set] : undefined;
  }
}

export async function runBenchmark(options: BenchOptions, onEvent: (e: BenchEvent) => void): Promise<Summary> {
  const startedAt = performance.now();
  const filteredQuestions = resolveQuestions(options.questionId);
  let models = listModels();
  if (options.models?.length) {
    const filters = options.models.map((m) => m.toLowerCase());
    models = models.filter((m) => filters.some((f) => m.name.toLowerCase().includes(f)));
    if (models.length === 0) {
      throw new Error(`No models match --models ${options.models.join(",")}. Run "npm run cli list" for names.`);
    }
  }

  const knownValues = new KnownValuesStore();
  knownValues.seed(options.resultsDir, filteredQuestions);

  const toRun: Pair[] = [];
  const skipped: Pair[] = [];
  for (const question of filteredQuestions) {
    const existing = options.force ? null : readQuestionFile(questionFilePath(options.resultsDir, question.id));
    for (const model of models) {
      const pair: Pair = { pairId: `${question.id}×${model.name}`, question, model };
      if (existing?.results.some((r) => r.model === model.name)) {
        skipped.push(pair);
      } else {
        toRun.push(pair);
      }
    }
  }

  onEvent({ type: "benchmark-started", totalPairs: toRun.length + skipped.length, skippedPairs: skipped.length });
  for (const pair of skipped) {
    onEvent({ type: "pair-skipped", questionId: pair.question.id, model: pair.model.name });
  }

  const llm = createLlmClient({
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
    maxOutputTokens: options.maxOutputTokens,
    signal: options.signal,
  });

  let totalCostUsd = 0;
  let failedPairs = 0;
  const pairLimit = pLimit(options.pairs);

  await Promise.all(
    toRun.map((pair) =>
      pairLimit(async () => {
        if (options.signal?.aborted) return;
        const { costUsd, status } = await runPair(pair, options, llm, knownValues, onEvent);
        totalCostUsd += costUsd;
        if (status === "failed") failedPairs++;
      })
    )
  );

  const durationMs = Math.round(performance.now() - startedAt);
  onEvent({ type: "benchmark-finished", totalCostUsd, durationMs });

  return {
    totalPairs: toRun.length + skipped.length,
    ranPairs: toRun.length,
    skippedPairs: skipped.length,
    failedPairs,
    totalCostUsd,
    durationMs,
  };
}

async function runPair(
  pair: Pair,
  options: BenchOptions,
  llm: LlmClient,
  knownValues: KnownValuesStore,
  onEvent: (e: BenchEvent) => void
): Promise<{ costUsd: number; status: PairStatus }> {
  const { question: q, model } = pair;
  const base = { pairId: pair.pairId, questionId: q.id, model: model.name };
  const configHash = benchConfigHash(q.normalizationPrompt);
  const qHash = questionHash(q);
  onEvent({ type: "pair-started", ...base });

  const allAnswers: string[] = [];
  const allRawRuns: RawRun[] = [];
  let attempts = 0;
  let costUsd = 0;
  let batchNum = 0;
  let aborted = false;

  while (true) {
    if (options.signal?.aborted) {
      aborted = true;
      break;
    }
    const remaining = options.maxRuns - attempts;
    if (remaining <= 0) break;
    const thisBatch = Math.min(options.batchSize, remaining);
    batchNum++;

    const known = q.openEnded ? knownValues.snapshot(q.id) : undefined;
    onEvent({ type: "batch-started", ...base, batch: batchNum, size: thisBatch, runsSoFar: attempts });

    // Cycle through prompt variants across the whole pair
    const batchStart = attempts;
    const runs = await Promise.all(
      Array.from({ length: thisBatch }, async (_, i) => {
        const runIndex = batchStart + i;
        const promptIndex = runIndex % q.prompts.length;
        const prompt = q.prompts[promptIndex];
        const logBase = {
          ts: new Date().toISOString(),
          runId: `${q.id}:${model.name}:${batchNum}:${runIndex}`,
          questionId: q.id,
          model: model.name,
          batch: batchNum,
          runIndex,
          promptIndex,
          prompt,
          configHash,
          questionHash: qHash,
          normalizer: NORMALIZATION_MODEL,
        };
        let stage = "preference";
        try {
          const pref = await llm.askPreference({ modelName: model.name, prompt });
          stage = "normalization";
          const norm = await llm.normalize({
            normalizationPrompt: q.normalizationPrompt,
            rawText: pref.text,
            knownValues: known,
          });
          if (q.openEnded) knownValues.add(q.id, norm.value);
          appendRunLog(options.runLogPath, {
            ...logBase,
            raw: pref.text,
            ...(pref.reasoning ? { reasoning: pref.reasoning } : {}),
            normalized: norm.value,
            pref: pref.stats,
            norm: norm.stats,
          });
          const runCost = pref.stats.costUsd + norm.stats.costUsd;
          onEvent({
            type: "run-finished",
            ...base,
            prompt,
            raw: pref.text,
            reasoning: pref.reasoning,
            normalized: norm.value,
            costUsd: runCost,
            latencyMs: pref.stats.latencyMs + norm.stats.latencyMs,
          });
          return { prompt, rawResponse: pref.text, normalizedAnswer: norm.value, costUsd: runCost };
        } catch (err) {
          const message = `${stage} call: ${describeLlmError(err, {
            timeoutMs: options.timeoutMs,
            benchSignal: options.signal,
          })}`;
          appendRunLog(options.runLogPath, { ...logBase, error: message });
          onEvent({ type: "run-failed", ...base, error: message });
          return null;
        }
      })
    );
    attempts += thisBatch;

    const succeeded = runs.filter((r) => r !== null);
    for (const run of succeeded) {
      allAnswers.push(run.normalizedAnswer);
      allRawRuns.push({ prompt: run.prompt, rawResponse: run.rawResponse, normalizedAnswer: run.normalizedAnswer });
      costUsd += run.costUsd;
    }

    // A batch with zero successes means the model is failing hard; stop trying.
    if (succeeded.length === 0) break;

    if (options.threshold !== undefined) {
      const counts = new Map<string, number>();
      for (const a of allAnswers) counts.set(a, (counts.get(a) ?? 0) + 1);
      if (Math.max(...counts.values()) >= options.threshold) break;
    }
  }

  if (allAnswers.length === 0) {
    const status: PairStatus = aborted ? "aborted" : "failed";
    onEvent({ type: "pair-finished", ...base, status, runs: 0, answers: [], costUsd });
    return { costUsd, status };
  }

  const answers = aggregateAnswers(allAnswers);
  await mergeModelResult(options.resultsDir, q, {
    model: model.name,
    company: model.company,
    benchmarkedAt: new Date().toISOString(),
    questionHash: qHash,
    runs: allRawRuns.length,
    answers,
    raw: allRawRuns,
    ...(model.hidden ? { hidden: true } : {}),
  });

  const counts = new Map<string, number>();
  for (const a of allAnswers) counts.set(a, (counts.get(a) ?? 0) + 1);
  const status: PairStatus = aborted
    ? "aborted"
    : options.threshold !== undefined && Math.max(...counts.values()) >= options.threshold
      ? "consensus"
      : "max-runs";
  onEvent({ type: "pair-finished", ...base, status, runs: allRawRuns.length, answers, costUsd });
  return { costUsd, status };
}
