import { CLOSED_FORM_VALUES, type ModelResult } from "./types.js";

export interface OutlierParams {
  /** Contrarian tier: model's #1 answer must cover at least this % of its own runs. */
  minConfidence: number;
  /** Contrarian tier: the answer's macro-avg % across the other models must be below this. */
  maxOtherMacro: number;
  /** Occasional tier: any answer must cover at least this % of the model's own runs. */
  minSupport: number;
  /** Occasional tier: raw run count backing the answer (excludes one-run flukes). */
  minCount: number;
  /** Occasional tier: the answer's macro-avg % across the other models must be below this. */
  maxRareMacro: number;
  /** Guard: ineligible when more than this many non-muted answers have macro-avg ≥ consensusThreshold. */
  maxConsensusAnswers: number;
  /** Guard: macro-avg % for an answer to count as "highly rated" for the diversity guard. */
  consensusThreshold: number;
  /** Guard: ineligible when more than this many detected outliers are completely unique. */
  maxUniqueOutliers: number;
}

export const DEFAULT_OUTLIER_PARAMS: OutlierParams = {
  minConfidence: 60,
  maxOtherMacro: 5,
  minSupport: 10,
  minCount: 2,
  maxRareMacro: 1,
  maxConsensusAnswers: 3,
  consensusThreshold: 5,
  maxUniqueOutliers: 5,
};

export interface Outlier {
  model: string;
  company?: string;
  /** The outlier answer (never "other"). */
  value: string;
  /** Share of the model's own runs. */
  percent: number;
  /** Raw run count backing the answer. */
  count: number;
  runs: number;
  /** contrarian = confident #1 answer; occasional = rare side answer. */
  tier: "contrarian" | "occasional";
  /** muted = the value is "hedge" or "refusal". */
  kind: "answer" | "muted";
  /** Macro-avg % of this value across the other models. */
  otherMacroPercent: number;
  /** No other model gives this value at all. */
  unique: boolean;
  /** Sort key: percent / (otherMacroPercent + 1); higher = more surprising. */
  score: number;
}

export type OutlierSkipReason = "no-results" | "too-diverse" | "too-many-unique";

export interface QuestionOutliers {
  /** When false the site should not display outliers; they are still populated for exploration. */
  eligible: boolean;
  skipReason?: OutlierSkipReason;
  /** Top non-muted answer by macro-avg, for display context. */
  consensus?: { value: string; percent: number };
  /** Sorted by score descending. */
  outliers: Outlier[];
}

export type OutlierModelResult = Pick<ModelResult, "model" | "company" | "runs" | "answers" | "hidden">;

const round1 = (n: number) => Math.round(n * 10) / 10;

export function detectOutliers(
  results: OutlierModelResult[],
  params?: Partial<OutlierParams>,
): QuestionOutliers {
  const p = { ...DEFAULT_OUTLIER_PARAMS, ...params };
  const models = results.filter((r) => !r.hidden);
  if (models.length === 0) {
    return { eligible: false, skipReason: "no-results", outliers: [] };
  }

  // Macro-average of every value across all visible models (0 when absent),
  // same math as the site's computeStats.
  const totals = new Map<string, number>();
  for (const m of models) {
    for (const a of m.answers) {
      totals.set(a.value, (totals.get(a.value) ?? 0) + a.percent);
    }
  }
  const macro = new Map<string, number>();
  for (const [value, sum] of totals) {
    macro.set(value, sum / models.length);
  }

  const realMacro = [...macro.entries()].filter(([value]) => !CLOSED_FORM_VALUES.has(value));
  const topReal = realMacro.reduce<[string, number] | undefined>(
    (best, entry) => (best === undefined || entry[1] > best[1] ? entry : best),
    undefined,
  );
  const consensus = topReal ? { value: topReal[0], percent: round1(topReal[1]) } : undefined;

  const outliers: Outlier[] = [];
  for (const m of models) {
    for (const a of m.answers) {
      if (a.value === "other") continue; // normalization bucket, not an opinion
      const holders = models.filter((o) => o !== m && o.answers.some((x) => x.value === a.value));
      const otherMacro =
        models.length > 1 ? ((totals.get(a.value) ?? 0) - a.percent) / (models.length - 1) : 0;

      const isTop = m.answers[0] === a;
      const contrarian = isTop && a.percent >= p.minConfidence && otherMacro < p.maxOtherMacro;
      const occasional = a.percent >= p.minSupport && a.count >= p.minCount && otherMacro < p.maxRareMacro;
      if (!contrarian && !occasional) continue;

      const otherMacroPercent = round1(otherMacro);
      outliers.push({
        model: m.model,
        company: m.company,
        value: a.value,
        percent: a.percent,
        count: a.count,
        runs: m.runs,
        tier: contrarian ? "contrarian" : "occasional",
        kind: CLOSED_FORM_VALUES.has(a.value) ? "muted" : "answer",
        otherMacroPercent,
        unique: holders.length === 0,
        score: Math.round((a.percent / (otherMacroPercent + 1)) * 100) / 100,
      });
    }
  }
  outliers.sort((a, b) => b.score - a.score || b.percent - a.percent);

  // Guards decide display eligibility; outliers stay populated for exploration.
  const highlyRated = realMacro.filter(([, pct]) => pct >= p.consensusThreshold).length;
  if (highlyRated > p.maxConsensusAnswers) {
    return { eligible: false, skipReason: "too-diverse", consensus, outliers };
  }
  const uniqueCount = outliers.filter((o) => o.unique).length;
  if (uniqueCount > p.maxUniqueOutliers) {
    return { eligible: false, skipReason: "too-many-unique", consensus, outliers };
  }

  return { eligible: true, consensus, outliers };
}
