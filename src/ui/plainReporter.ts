import type { BenchEvent } from "../bench/types.js";
import { formatCost, shortModel } from "./format.js";

// Non-TTY / --no-ui fallback: append-only log lines. Pair-scoped lines carry a
// [question × model] prefix because concurrent pairs interleave.
export function createPlainReporter(): (e: BenchEvent) => void {
  let runnablePairs = 0;
  let started = 0;
  const logReasoning = process.env.LOG_REASONING === "true";

  const tag = (e: { questionId: string; model: string }) => `[${e.questionId} × ${shortModel(e.model)}]`;

  return (e) => {
    switch (e.type) {
      case "benchmark-started":
        runnablePairs = e.totalPairs - e.skippedPairs;
        break;
      case "pair-skipped":
        console.log(`Skipping "${e.questionId}" × ${shortModel(e.model)} — already have results (use --force to overwrite)`);
        break;
      case "pair-started":
        started++;
        console.log(`Running "${e.questionId}" × ${shortModel(e.model)} (${started}/${runnablePairs})...`);
        break;
      case "batch-started":
        console.log(`  ${tag(e)} batch ${e.batch} (${e.size} runs)...`);
        break;
      case "run-finished":
        console.log(`  ${tag(e)} prompt: ${e.prompt}`);
        if (logReasoning && e.reasoning) console.log(`  ${tag(e)} reasoning: ${e.reasoning.trim()}`);
        console.log(`  ${tag(e)} raw: ${e.raw.trim()}`);
        break;
      case "run-failed":
        console.log(`  ${tag(e)} run failed: ${e.error}`);
        break;
      case "pair-finished":
        if (e.status === "failed") {
          console.log(`  ${tag(e)} failed — no successful runs`);
        } else {
          const label = e.status === "max-runs" ? "done" : e.status;
          console.log(
            `  ${tag(e)} ${label} after ${e.runs} runs, cost ${formatCost(e.costUsd)} → ${e.answers.map((a) => `${a.value}: ${a.percent}%`).join(", ")}`
          );
        }
        break;
      case "benchmark-finished":
        break;
    }
  };
}
