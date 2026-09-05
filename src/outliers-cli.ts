import { parseArgs } from "node:util";
import fs from "fs";
import path from "path";
import { questions } from "./questions.js";
import {
  DEFAULT_OUTLIER_PARAMS,
  detectOutliers,
  type OutlierParams,
  type QuestionOutliers,
} from "./bench/outliers.js";
import type { QuestionFile } from "./bench/types.js";

function printUsage() {
  const d = DEFAULT_OUTLIER_PARAMS;
  console.log(`
Outlier explorer — flags models that go against the flow in results/*.json

Usage:
  npm run outliers [-- questionId] [flags]

Flags (defaults in parens):
  --min-confidence <n>        Contrarian: #1 answer's % of own runs (${d.minConfidence})
  --max-other-macro <n>       Contrarian: answer's macro-avg % among other models (${d.maxOtherMacro})
  --min-support <n>           Occasional: any answer's % of own runs (${d.minSupport})
  --min-count <n>             Occasional: raw run count backing the answer (${d.minCount})
  --max-rare-macro <n>        Occasional: answer's macro-avg % among other models (${d.maxRareMacro})
  --max-consensus-answers <n> Skip question when more answers than this have
                              macro-avg >= --consensus-threshold (${d.maxConsensusAnswers})
  --consensus-threshold <n>   Macro-avg % for an answer to count as highly rated (${d.consensusThreshold})
  --max-unique-outliers <n>   Skip question when more outliers than this are unique (${d.maxUniqueOutliers})
  --top <n>                   Show at most n outliers per question
  --all                       Also show outliers detected on skipped questions
  --json                      Dump { questionId: QuestionOutliers } as JSON

Examples:
  npm run outliers
  npm run outliers -- elon-vs-tyson
  npm run outliers -- --min-support 5 --min-count 1 --all
`);
}

function numOption(flagValue: string | undefined, name: string, fallback: number): number {
  if (flagValue === undefined || flagValue === "") return fallback;
  const n = Number(flagValue);
  if (Number.isNaN(n) || n < 0) {
    console.error(`Error: invalid value "${flagValue}" for --${name}`);
    process.exit(1);
  }
  return n;
}

function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    options: {
      "min-confidence": { type: "string" },
      "max-other-macro": { type: "string" },
      "min-support": { type: "string" },
      "min-count": { type: "string" },
      "max-rare-macro": { type: "string" },
      "max-consensus-answers": { type: "string" },
      "consensus-threshold": { type: "string" },
      "max-unique-outliers": { type: "string" },
      top: { type: "string" },
      all: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    printUsage();
    return;
  }

  const d = DEFAULT_OUTLIER_PARAMS;
  const params: OutlierParams = {
    minConfidence: numOption(values["min-confidence"], "min-confidence", d.minConfidence),
    maxOtherMacro: numOption(values["max-other-macro"], "max-other-macro", d.maxOtherMacro),
    minSupport: numOption(values["min-support"], "min-support", d.minSupport),
    minCount: numOption(values["min-count"], "min-count", d.minCount),
    maxRareMacro: numOption(values["max-rare-macro"], "max-rare-macro", d.maxRareMacro),
    maxConsensusAnswers: numOption(values["max-consensus-answers"], "max-consensus-answers", d.maxConsensusAnswers),
    consensusThreshold: numOption(values["consensus-threshold"], "consensus-threshold", d.consensusThreshold),
    maxUniqueOutliers: numOption(values["max-unique-outliers"], "max-unique-outliers", d.maxUniqueOutliers),
  };
  const top = values.top ? numOption(values.top, "top", Infinity) : Infinity;
  const onlyId = positionals[0];

  const resultsDir = path.join(process.cwd(), "results");
  const hiddenIds = new Set(questions.filter((q) => q.hidden).map((q) => q.id));
  const files = fs
    .readdirSync(resultsDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  const byQuestion = new Map<string, { file: QuestionFile; result: QuestionOutliers }>();
  for (const f of files) {
    const file = JSON.parse(fs.readFileSync(path.join(resultsDir, f), "utf-8")) as QuestionFile;
    if (hiddenIds.has(file.id)) continue;
    if (onlyId && file.id !== onlyId) continue;
    byQuestion.set(file.id, { file, result: detectOutliers(file.results, params) });
  }

  if (onlyId && byQuestion.size === 0) {
    console.error(`Error: no results file for question "${onlyId}"`);
    process.exit(1);
  }

  if (values.json) {
    const out: Record<string, QuestionOutliers> = {};
    for (const [id, { result }] of byQuestion) out[id] = result;
    console.log(JSON.stringify(out, null, 2));
    return;
  }

  const skipped: Array<{ id: string; result: QuestionOutliers }> = [];
  for (const [id, { result }] of byQuestion) {
    if (!result.eligible) {
      skipped.push({ id, result });
      if (!values.all) continue;
    }
    if (result.outliers.length === 0) continue;

    const header = result.eligible ? id : `${id}  [skipped: ${result.skipReason}]`;
    const consensus = result.consensus
      ? `consensus: ${result.consensus.value} (${result.consensus.percent}% macro-avg)`
      : "no non-muted consensus";
    console.log(`\n${header} — ${consensus}`);
    for (const o of result.outliers.slice(0, top)) {
      const marks = [o.unique ? "unique" : "", o.kind === "muted" ? "muted" : ""].filter(Boolean);
      console.log(
        `  ${o.tier.padEnd(10)} ${o.model.padEnd(42)} ${JSON.stringify(o.value)}` +
          ` ${o.count}/${o.runs} runs (${o.percent}%), ${o.otherMacroPercent}% among others,` +
          ` score ${o.score}${marks.length ? `  [${marks.join(", ")}]` : ""}`,
      );
    }
    const hidden = result.outliers.length - Math.min(result.outliers.length, top);
    if (hidden > 0) console.log(`  … ${hidden} more (raise --top to show)`);
  }

  if (skipped.length > 0) {
    console.log(`\nSkipped ${skipped.length} question${skipped.length === 1 ? "" : "s"}:`);
    for (const { id, result } of skipped) {
      console.log(`  ${id.padEnd(28)} ${result.skipReason} (${result.outliers.length} outliers detected)`);
    }
    if (!values.all) console.log("  (use --all to show their detected outliers)");
  }
}

main();
