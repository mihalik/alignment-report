import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { aggregateAnswers, mergeModelResult, questionFilePath, questionHash, readQuestionFile } from "./results.js";
import type { ModelResult } from "./types.js";
import type { Question } from "../questions.js";

describe("aggregateAnswers", () => {
  it("counts answers and sorts descending by count", () => {
    const answers = aggregateAnswers(["dog", "cat", "dog", "dog", "cat"]);
    expect(answers).toEqual([
      { value: "dog", count: 3, percent: 60 },
      { value: "cat", count: 2, percent: 40 },
    ]);
  });

  it("rounds percents to one decimal", () => {
    const answers = aggregateAnswers(["a", "a", "b"]);
    expect(answers[0]).toEqual({ value: "a", count: 2, percent: 66.7 });
    expect(answers[1]).toEqual({ value: "b", count: 1, percent: 33.3 });
  });

  it("fudges the top answer so percents sum to exactly 100", () => {
    const answers = aggregateAnswers(["a", "b", "c"]);
    // 33.3 × 3 = 99.9, so the top entry absorbs the missing 0.1
    expect(answers[0].percent).toBe(33.4);
    expect(answers.reduce((acc, a) => acc + a.percent, 0)).toBeCloseTo(100, 9);
  });

  it("handles a unanimous result", () => {
    expect(aggregateAnswers(["x", "x"])).toEqual([{ value: "x", count: 2, percent: 100 }]);
  });

  it("keeps insertion order for tied counts (stable sort)", () => {
    const answers = aggregateAnswers(["first", "second"]);
    expect(answers.map((a) => a.value)).toEqual(["first", "second"]);
  });
});

describe("questionHash", () => {
  const question: Question = {
    id: "q",
    prompts: ["A?", "B?"],
    displayQuestion: "A?",
    note: "a note",
    normalizationPrompt: "normalize it",
  };

  it("is stable for identical content", () => {
    expect(questionHash(question)).toBe(questionHash({ ...question }));
    expect(questionHash(question)).toMatch(/^[0-9a-f]{12}$/);
  });

  it("changes when prompts or normalizationPrompt change", () => {
    expect(questionHash({ ...question, prompts: ["A?", "C?"] })).not.toBe(questionHash(question));
    expect(questionHash({ ...question, normalizationPrompt: "different" })).not.toBe(questionHash(question));
  });

  it("ignores display-only fields", () => {
    expect(questionHash({ ...question, displayQuestion: "Other", note: undefined, tags: ["x"] })).toBe(
      questionHash(question)
    );
  });
});

describe("mergeModelResult", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "results-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const question: Question = {
    id: "test-q",
    prompts: ["Prompt A?", "Prompt B?"],
    displayQuestion: "Prompt A?",
    normalizationPrompt: "normalize it",
  };

  function entry(model: string, value = "yes"): ModelResult {
    return {
      model,
      company: "TestCo",
      benchmarkedAt: "2026-07-04T00:00:00.000Z",
      runs: 1,
      answers: [{ value, count: 1, percent: 100 }],
      raw: [{ prompt: "Prompt A?", rawResponse: value, normalizedAnswer: value }],
    };
  }

  it("creates a new question file with the entry", async () => {
    await mergeModelResult(dir, question, entry("provider/model-a"));
    const file = readQuestionFile(questionFilePath(dir, "test-q"));
    expect(file).toMatchObject({
      id: "test-q",
      prompts: question.prompts,
      displayQuestion: "Prompt A?",
      results: [{ model: "provider/model-a", benchmarkedAt: "2026-07-04T00:00:00.000Z" }],
    });
  });

  it("replaces an existing model entry and preserves others", async () => {
    await mergeModelResult(dir, question, entry("provider/model-a", "yes"));
    await mergeModelResult(dir, question, entry("provider/model-b", "no"));
    await mergeModelResult(dir, question, entry("provider/model-a", "maybe"));
    const file = readQuestionFile(questionFilePath(dir, "test-q"))!;
    expect(file.results).toHaveLength(2);
    expect(file.results[0].model).toBe("provider/model-a");
    expect(file.results[0].answers[0].value).toBe("maybe");
    expect(file.results[1].model).toBe("provider/model-b");
  });

  it("serializes concurrent merges to the same file without losing entries", async () => {
    const models = Array.from({ length: 20 }, (_, i) => `provider/model-${i}`);
    await Promise.all(models.map((m) => mergeModelResult(dir, question, entry(m))));
    const file = readQuestionFile(questionFilePath(dir, "test-q"))!;
    expect(file.results.map((r) => r.model).sort()).toEqual([...models].sort());
  });

  it("refreshes prompts and displayQuestion from the question definition", async () => {
    await mergeModelResult(dir, question, entry("provider/model-a"));
    const updated: Question = { ...question, prompts: ["New prompt?"], displayQuestion: "New prompt?" };
    await mergeModelResult(dir, updated, entry("provider/model-b"));
    const file = readQuestionFile(questionFilePath(dir, "test-q"))!;
    expect(file.prompts).toEqual(["New prompt?"]);
    expect(file.displayQuestion).toBe("New prompt?");
    expect(file.results).toHaveLength(2);
  });

  it("writes 2-space-indented JSON with a trailing newline (site contract)", async () => {
    await mergeModelResult(dir, question, entry("provider/model-a"));
    const text = fs.readFileSync(questionFilePath(dir, "test-q"), "utf-8");
    expect(text.endsWith("}\n")).toBe(true);
    expect(text).toContain('  "id": "test-q"');
  });
});
