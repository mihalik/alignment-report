import { Text } from "ink";
import { formatCost, shortModel } from "./format.js";

export type ActivePair = {
  pairId: string;
  questionId: string;
  model: string;
  batch: number;
  runs: number;
  failures: number;
  counts: Map<string, number>;
  costUsd: number;
};

export function PairRow({ pair, maxRuns }: { pair: ActivePair; maxRuns: number }) {
  const top = [...pair.counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return (
    <Text>
      <Text color="cyan">▸ </Text>
      <Text>{pair.questionId}</Text>
      <Text dimColor> × </Text>
      <Text color="cyan">{shortModel(pair.model)}</Text>
      <Text dimColor>
        {"  "}batch {pair.batch} · {pair.runs}/{maxRuns} runs
        {top ? ` · top: ${top[0]} ${top[1]}×` : ""}
        {pair.failures > 0 ? ` · ${pair.failures} failed` : ""} · {formatCost(pair.costUsd)}
      </Text>
    </Text>
  );
}
