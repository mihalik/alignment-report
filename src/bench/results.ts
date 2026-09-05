import { createHash } from "node:crypto";
import fs from "fs";
import path from "path";
import type { Answer, ModelResult, QuestionFile } from "./types.js";
import type { Question } from "../questions.js";

/**
 * Version fingerprint of the question content that shapes answers (prompt
 * variants + normalization prompt). Display-only fields (displayQuestion,
 * note, tags) are excluded — editing them doesn't invalidate results.
 */
export function questionHash(question: Question): string {
  return createHash("sha256")
    .update([...question.prompts, question.normalizationPrompt].join("\x1f"))
    .digest("hex")
    .slice(0, 12);
}

export function questionFilePath(resultsDir: string, questionId: string): string {
  return path.join(resultsDir, `${questionId}.json`);
}

export function readQuestionFile(filePath: string): QuestionFile | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8")) as QuestionFile;
}

export function aggregateAnswers(allAnswers: string[]): Answer[] {
  const total = allAnswers.length;
  const counts = new Map<string, number>();
  for (const val of allAnswers) {
    counts.set(val, (counts.get(val) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const answers = entries.map(([value, count]) => ({
    value,
    count,
    percent: Math.round((count / total) * 1000) / 10,
  }));
  const sum = answers.reduce((acc, a) => acc + a.percent, 0);
  const diff = Math.round((100 - sum) * 10) / 10;
  if (answers.length > 0 && diff !== 0) {
    answers[0].percent = Math.round((answers[0].percent + diff) * 10) / 10;
  }
  return answers;
}

// Per-file promise chains so concurrent pairs of the same question can't clobber
// each other's read-merge-write cycle.
const writeQueues = new Map<string, Promise<void>>();

export function mergeModelResult(resultsDir: string, question: Question, entry: ModelResult): Promise<void> {
  const filePath = questionFilePath(resultsDir, question.id);
  const prev = writeQueues.get(filePath) ?? Promise.resolve();
  const next = prev.then(() => {
    const existing = readQuestionFile(filePath);
    let fileData: QuestionFile;
    if (existing) {
      fileData = existing;
      fileData.prompts = question.prompts;
      fileData.displayQuestion = question.displayQuestion;
      fileData.note = question.note;
      const idx = fileData.results.findIndex((r) => r.model === entry.model);
      if (idx >= 0) {
        fileData.results[idx] = entry;
      } else {
        fileData.results.push(entry);
      }
    } else {
      fileData = {
        id: question.id,
        prompts: question.prompts,
        displayQuestion: question.displayQuestion,
        note: question.note,
        results: [entry],
      };
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(fileData, null, 2) + "\n", "utf-8");
  });
  writeQueues.set(filePath, next);
  return next;
}
