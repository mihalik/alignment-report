import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { questions as questionDefs } from '../../../src/questions.js';

export interface ModelResult {
  model: string;
  company?: string;
  benchmarkedAt?: string;
  runs: number;
  answers: Array<{ value: string; count: number; percent: number }>;
  hidden?: boolean;
}

export interface QuestionPage {
  id: string;
  prompts: string[];
  displayQuestion?: string;
  note?: string;
  tags: string[];
  results: ModelResult[];
}

const resultsDir = join(dirname(fileURLToPath(import.meta.url)), '../../../results');

/**
 * `src/questions.ts` is the source of truth for what the site renders: questions
 * that were removed or commented out there are skipped even if a stale results
 * file is still on disk, and prompts/notes/tags come from the definition rather
 * than from the (possibly older) results file.
 */
export function loadQuestions(): QuestionPage[] {
  const pages: QuestionPage[] = [];

  for (const q of questionDefs) {
    if (q.hidden) continue;

    const file = join(resultsDir, `${q.id}.json`);
    if (!existsSync(file)) continue;

    const data = JSON.parse(readFileSync(file, 'utf8')) as { results?: ModelResult[] };
    const results = (data.results ?? []).filter((r) => !r.hidden);
    if (!results.length) continue;

    pages.push({
      id: q.id,
      prompts: q.prompts,
      displayQuestion: q.displayQuestion,
      note: q.note,
      tags: q.tags ?? [],
      results,
    });
  }

  return pages;
}
