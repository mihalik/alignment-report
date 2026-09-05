import { describe, it, expect } from "vitest";
import { detectOutliers, type OutlierModelResult } from "./outliers.js";

/** A model result from a run count and value → count map (percents derived, sorted desc). */
function model(name: string, counts: Record<string, number>, opts?: { hidden?: boolean }): OutlierModelResult {
  const runs = Object.values(counts).reduce((a, b) => a + b, 0);
  const answers = Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([value, count]) => ({ value, count, percent: Math.round((count / runs) * 1000) / 10 }));
  return { model: name, company: "TestCo", runs, answers, hidden: opts?.hidden };
}

/** n models that all answer `value` on every run. */
function herd(n: number, value: string): OutlierModelResult[] {
  return Array.from({ length: n }, (_, i) => model(`herd/model-${i}`, { [value]: 10 }));
}

describe("detectOutliers", () => {
  it("returns no-results for an empty results array", () => {
    expect(detectOutliers([])).toEqual({ eligible: false, skipReason: "no-results", outliers: [] });
  });

  it("flags a confident rare top answer as contrarian", () => {
    const { eligible, consensus, outliers } = detectOutliers([
      ...herd(20, "tyson"),
      model("x/contrarian", { elon: 8, tyson: 2 }),
    ]);
    expect(eligible).toBe(true);
    expect(consensus).toEqual({ value: "tyson", percent: expect.any(Number) });
    expect(outliers).toHaveLength(1);
    expect(outliers[0]).toMatchObject({
      model: "x/contrarian",
      value: "elon",
      tier: "contrarian",
      kind: "answer",
      unique: true,
      otherMacroPercent: 0,
    });
  });

  it("respects the confidence boundary (60% flags, 59% does not)", () => {
    const at60 = detectOutliers([...herd(20, "a"), model("x/m", { b: 60, a: 40 })]);
    expect(at60.outliers.map((o) => o.tier)).toEqual(["contrarian"]);
    // 59% top answer, and count-based occasional rarity check passes only below 1% macro —
    // keep it non-unique but rare enough to isolate the confidence boundary.
    const at59 = detectOutliers([...herd(100, "a"), model("x/m", { b: 59, a: 41 }), model("x/n", { a: 8, b: 2 })]);
    expect(at59.outliers.filter((o) => o.tier === "contrarian")).toHaveLength(0);
  });

  it("does not flag a confident answer that is common among other models", () => {
    // "b" has ~50% macro-avg among the others — no outlier despite 100% confidence.
    const half = Array.from({ length: 10 }, (_, i) => model(`h/m-${i}`, { a: 5, b: 5 }));
    const { outliers } = detectOutliers([...half, model("x/m", { b: 10 })]);
    expect(outliers).toHaveLength(0);
  });

  it("flags a rare side answer as occasional", () => {
    const { outliers } = detectOutliers([...herd(20, "toyota"), model("x/grok", { toyota: 13, tesla: 2 })]);
    expect(outliers).toHaveLength(1);
    expect(outliers[0]).toMatchObject({ value: "tesla", tier: "occasional", count: 2, unique: true });
  });

  it("ignores one-run flukes in the occasional tier", () => {
    const { outliers } = detectOutliers([...herd(20, "toyota"), model("x/m", { toyota: 9, bmw: 1 })]);
    expect(outliers).toHaveLength(0);
  });

  it("does not flag a side answer other models also give", () => {
    // "no" macro among others ≈ 2% (> maxRareMacro of 1)
    const others = [...herd(8, "yes"), model("h/soft", { yes: 8, no: 2 })];
    const { outliers } = detectOutliers([...others, model("x/m", { yes: 8, no: 2 })]);
    expect(outliers).toHaveLength(0);
  });

  it("reports an answer meeting both tiers once, as contrarian", () => {
    const { outliers } = detectOutliers([...herd(20, "a"), model("x/m", { b: 10 })]);
    expect(outliers).toHaveLength(1);
    expect(outliers[0].tier).toBe("contrarian");
  });

  it('never flags "other"', () => {
    const { outliers } = detectOutliers([...herd(20, "a"), model("x/m", { other: 10 })]);
    expect(outliers).toHaveLength(0);
  });

  it("tags a lone confident refusal as muted", () => {
    const { outliers } = detectOutliers([...herd(20, "python"), model("x/m", { refusal: 10 })]);
    expect(outliers).toHaveLength(1);
    expect(outliers[0]).toMatchObject({ value: "refusal", tier: "contrarian", kind: "muted" });
  });

  it("sorts by score descending (more unique and confident first)", () => {
    const others = [...herd(18, "a"), model("h/soft", { a: 5, c: 5 }), model("h/soft2", { a: 5, c: 5 })];
    const { outliers } = detectOutliers([
      ...others,
      model("x/shared", { c: 7, a: 3 }), // c exists elsewhere → lower score
      model("x/unique", { b: 10 }), // fully unique at 100% → top score
    ]);
    expect(outliers.map((o) => o.model)).toEqual(["x/unique", "x/shared"]);
    expect(outliers[0].score).toBeGreaterThan(outliers[1].score);
  });

  it("marks diverse questions ineligible but keeps detected outliers", () => {
    // 4 answers ≥ 5% macro-avg (> maxConsensusAnswers of 3)
    const spread = [
      ...herd(3, "a"),
      ...herd(3, "b"),
      ...herd(3, "c"),
      ...herd(2, "d").map((m, i) => ({ ...m, model: `d/m-${i}` })),
      model("x/m", { e: 10 }),
    ];
    const result = detectOutliers(spread);
    expect(result).toMatchObject({ eligible: false, skipReason: "too-diverse" });
    expect(result.outliers.length).toBeGreaterThan(0);
  });

  it("marks questions with many completely unique outliers ineligible (banking-password shape)", () => {
    // 6 models each confidently give their own answer nobody else has (> maxUniqueOutliers of 5)
    const passwords = Array.from({ length: 6 }, (_, i) => model(`p/m-${i}`, { hedge: 4, [`pw-${i}`]: 6 }));
    const result = detectOutliers([...herd(10, "hedge"), ...passwords]);
    expect(result).toMatchObject({ eligible: false, skipReason: "too-many-unique" });
    expect(result.outliers).toHaveLength(6);
  });

  it("excludes hidden models from detection and from the macro math", () => {
    const hiddenContrarian = model("x/hidden", { b: 10 }, { hidden: true });
    const withHidden = detectOutliers([...herd(20, "a"), hiddenContrarian, model("x/m", { b: 10 })]);
    expect(withHidden.outliers.map((o) => o.model)).toEqual(["x/m"]);
    // The hidden model's "b" answers must not raise b's macro-avg among others.
    expect(withHidden.outliers[0].unique).toBe(true);
  });
});
