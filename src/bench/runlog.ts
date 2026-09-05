import fs from "fs";
import path from "path";
import type { CallStats } from "./types.js";

export type RunLogEntry = {
  ts: string;
  runId: string;
  questionId: string;
  model: string;
  batch: number;
  runIndex: number;
  promptIndex: number;
  prompt: string;
  /** Hash of all prompt/normalizer config shaping this run — see benchConfigHash. */
  configHash: string;
  /** Hash of the question content (prompts + normalizationPrompt) — see questionHash. */
  questionHash: string;
  /** Model used to normalize the raw response. */
  normalizer: string;
  raw?: string;
  reasoning?: string;
  normalized?: string;
  error?: string;
  pref?: CallStats;
  norm?: CallStats;
};

export function appendRunLog(filePath: string, entry: RunLogEntry): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(entry) + "\n", "utf-8");
}
