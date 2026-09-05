export type Answer = { value: string; count: number; percent: number };

export type RawRun = {
  prompt: string;
  rawResponse: string;
  normalizedAnswer: string;
};

export type ModelResult = {
  model: string;
  company: string;
  /** ISO timestamp of when this model×question pair was benchmarked. */
  benchmarkedAt?: string;
  /** Hash of the question content (prompts + normalizationPrompt) these results were produced against. */
  questionHash?: string;
  runs: number;
  answers: Answer[];
  raw: RawRun[];
  hidden?: boolean;
};

export type QuestionFile = {
  id: string;
  prompts: string[];
  displayQuestion?: string;
  note?: string;
  results: ModelResult[];
};

export type BenchOptions = {
  questionId?: string;
  /** Substring filters on model names; empty/undefined means all models. */
  models?: string[];
  force: boolean;
  /** Global cap on in-flight LLM requests (preference + normalization combined). */
  concurrency: number;
  /** Number of model×question pairs processed concurrently. */
  pairs: number;
  maxRuns: number;
  batchSize: number;
  /** Early-stop once one answer reaches this count; undefined = always run maxRuns. */
  threshold?: number;
  timeoutMs: number;
  maxRetries: number;
  /** Cap on output tokens per LLM call; undefined leaves the provider default. */
  maxOutputTokens?: number;
  resultsDir: string;
  runLogPath: string;
  /** Aborting stops new batches/pairs; partial pair results are still written. */
  signal?: AbortSignal;
};

export type CallStats = {
  latencyMs: number;
  tokensIn?: number;
  tokensOut?: number;
  costUsd: number;
  finishReason?: string;
  /** OpenRouter generation id — look up full details later via their /generation API. */
  generationId?: string;
  /** Upstream inference provider OpenRouter routed this call to. */
  provider?: string;
};

export type PairStatus = "consensus" | "max-runs" | "failed" | "aborted";

export type BenchEvent =
  | { type: "benchmark-started"; totalPairs: number; skippedPairs: number }
  | { type: "pair-skipped"; questionId: string; model: string }
  | { type: "pair-started"; pairId: string; questionId: string; model: string }
  | {
      type: "batch-started";
      pairId: string;
      questionId: string;
      model: string;
      batch: number;
      size: number;
      runsSoFar: number;
    }
  | {
      type: "run-finished";
      pairId: string;
      questionId: string;
      model: string;
      prompt: string;
      raw: string;
      reasoning?: string;
      normalized: string;
      costUsd: number;
      latencyMs: number;
    }
  | { type: "run-failed"; pairId: string; questionId: string; model: string; error: string }
  | {
      type: "pair-finished";
      pairId: string;
      questionId: string;
      model: string;
      status: PairStatus;
      runs: number;
      answers: Answer[];
      costUsd: number;
    }
  | { type: "benchmark-finished"; totalCostUsd: number; durationMs: number };

export type Summary = {
  totalPairs: number;
  ranPairs: number;
  skippedPairs: number;
  failedPairs: number;
  totalCostUsd: number;
  durationMs: number;
};

export const CLOSED_FORM_VALUES = new Set(["other", "refusal", "hedge"]);
