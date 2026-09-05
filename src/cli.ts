import { parseArgs } from "node:util";
import path from "path";
import { questions } from "./questions.js";
import { listModels } from "./models.js";
import { resolveQuestions, runBenchmark } from "./bench/orchestrator.js";
import type { BenchOptions } from "./bench/types.js";
import { createPlainReporter } from "./ui/plainReporter.js";
import { renderSummary } from "./ui/summary.js";

function printUsage() {
  console.log(`
Preference Benchmark CLI

Usage:
  npm run cli list                      List question ids and models
  npm run cli run [questionId]          Run the benchmark (all questions, or one)

Flags (flag > env var > default):
  --force / --overwrite     Re-run pairs that already have results
  --models <a,b,...>        Only models whose name contains one of these substrings
  --concurrency <n>         Global in-flight LLM request limit (LLM_CONCURRENCY, default 10)
  --pairs <n>               Model×question pairs run concurrently (BENCH_PAIRS, default 4)
  --max-runs <n>            Runs per pair (MAX_RUNS, default 10)
  --threshold <n>           Early-stop once one answer reaches n (CONSENSUS_THRESHOLD;
                            default off — every pair runs the full --max-runs)
  --batch-size <n>          Runs per batch (BATCH_SIZE, default = threshold if set, else 5)
  --no-ui                   Plain log output instead of the interactive UI

Env only: LLM_TIMEOUT_MS (60000), LLM_MAX_RETRIES (3), LLM_MAX_OUTPUT_TOKENS (provider default),
          LOG_REASONING (plain output only)

Examples:
  npm run cli run
  npm run cli -- run cat-or-dog --force
  npm run cli -- run --concurrency 20 --pairs 8
`);
}

function listQuestionsAndModels() {
  console.log("Questions:");
  for (const q of questions) {
    console.log(`  ${q.id}${q.hidden ? " (hidden)" : ""}`);
  }
  console.log("\nModels:");
  for (const m of listModels()) {
    const meta = [m.released, m.hidden ? "hidden" : ""].filter(Boolean).join(", ");
    console.log(`  ${m.name}${meta ? `  (${meta})` : ""}`);
  }
}

function intOption(flagValue: string | undefined, envName: string, fallback: number): number {
  const raw = flagValue ?? process.env[envName];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  if (Number.isNaN(n) || n <= 0) {
    console.error(`Error: invalid value "${raw}" for ${envName}`);
    process.exit(1);
  }
  return n;
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      force: { type: "boolean", default: false },
      overwrite: { type: "boolean", default: false },
      concurrency: { type: "string" },
      models: { type: "string" },
      pairs: { type: "string" },
      "max-runs": { type: "string" },
      "batch-size": { type: "string" },
      threshold: { type: "string" },
      "no-ui": { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  const [command, ...rest] = positionals;

  if (!command || command === "help" || values.help) {
    printUsage();
    return;
  }

  if (command === "list") {
    listQuestionsAndModels();
    return;
  }

  if (command !== "run") {
    console.error(`Unknown command: ${command}\n`);
    printUsage();
    process.exit(1);
  }

  if (!process.env.OPENROUTER_API_KEY) {
    console.error("Error: OPENROUTER_API_KEY environment variable is required.");
    process.exit(1);
  }

  // Back-compat: "run preference <id>" was the old form
  const questionId = rest[0] === "preference" ? rest[1] : rest[0];

  // Fixed run count by default; consensus early-stop only when a threshold is given.
  const thresholdSet = values.threshold !== undefined || !!process.env.CONSENSUS_THRESHOLD;
  const threshold = thresholdSet ? intOption(values.threshold, "CONSENSUS_THRESHOLD", 0) : undefined;
  const resultsDir = path.join(process.cwd(), "results");
  const controller = new AbortController();

  const options: BenchOptions = {
    questionId,
    models: values.models?.split(",").map((m) => m.trim()).filter(Boolean),
    force: values.force || values.overwrite,
    concurrency: intOption(values.concurrency, "LLM_CONCURRENCY", 10),
    pairs: intOption(values.pairs, "BENCH_PAIRS", 4),
    maxRuns: intOption(values["max-runs"], "MAX_RUNS", 10),
    batchSize: intOption(values["batch-size"], "BATCH_SIZE", threshold ?? 5),
    threshold,
    timeoutMs: intOption(undefined, "LLM_TIMEOUT_MS", 60_000),
    maxRetries: intOption(undefined, "LLM_MAX_RETRIES", 3),
    maxOutputTokens: process.env.LLM_MAX_OUTPUT_TOKENS
      ? intOption(undefined, "LLM_MAX_OUTPUT_TOKENS", 0)
      : undefined,
    resultsDir,
    runLogPath: path.join(resultsDir, "runs.jsonl"),
    signal: controller.signal,
  };

  let filteredQuestions;
  try {
    filteredQuestions = resolveQuestions(questionId);
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  // First Ctrl-C drains gracefully (no new batches, in-flight requests aborted,
  // finished pairs stay on disk); second Ctrl-C force-quits.
  let interrupts = 0;
  const onInterrupt = () => {
    interrupts++;
    if (interrupts >= 2) process.exit(130);
    controller.abort();
  };
  process.on("SIGINT", onInterrupt);

  const useInk = process.stdout.isTTY && !values["no-ui"];
  let summary;
  if (useInk) {
    const { startInkUi } = await import("./ui/App.js");
    const ui = startInkUi({ onInterrupt, maxRuns: options.maxRuns });
    try {
      summary = await runBenchmark(options, ui.emit);
    } finally {
      await ui.finish();
    }
  } else {
    summary = await runBenchmark(options, createPlainReporter());
  }

  console.log(renderSummary(filteredQuestions, resultsDir, summary));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
