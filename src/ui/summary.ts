import type { Question } from "../questions.js";
import type { Summary } from "../bench/types.js";
import { questionFilePath, readQuestionFile } from "../bench/results.js";
import { formatCost, formatDuration, shortModel } from "./format.js";

export function renderSummary(filteredQuestions: Question[], resultsDir: string, summary: Summary): string {
  const lines: string[] = [];
  lines.push("\n--- Summary ---");
  lines.push(
    `Pairs: ${summary.ranPairs} run, ${summary.skippedPairs} skipped${summary.failedPairs ? `, ${summary.failedPairs} failed` : ""}`
  );
  lines.push(`Total cost: ${formatCost(summary.totalCostUsd)} in ${formatDuration(summary.durationMs)}`);
  for (const q of filteredQuestions) {
    const data = readQuestionFile(questionFilePath(resultsDir, q.id));
    if (!data) continue;
    lines.push(`\n${q.id}:`);
    for (const r of data.results) {
      const answers = r.answers.map((a) => `${a.value}: ${a.percent}%`).join(", ");
      lines.push(`  ${shortModel(r.model)} (${r.runs} runs): ${answers}`);
    }
  }
  return lines.join("\n");
}
