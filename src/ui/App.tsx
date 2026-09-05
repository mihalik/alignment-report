import { useEffect, useReducer } from "react";
import { render, Box, Text, Static, useInput } from "ink";
import type { Answer, BenchEvent, PairStatus } from "../bench/types.js";
import { formatCost, shortModel } from "./format.js";
import { PairRow, type ActivePair } from "./PairRow.js";
import { ProgressBar } from "./ProgressBar.js";

type CompletedPair = {
  pairId: string;
  questionId: string;
  model: string;
  status: PairStatus;
  runs: number;
  answers: Answer[];
  costUsd: number;
};

type UiState = {
  totalPairs: number;
  skipped: number;
  done: number;
  costUsd: number;
  active: ActivePair[];
  completed: CompletedPair[];
  finished: boolean;
  aborting: boolean;
};

const initialState: UiState = {
  totalPairs: 0,
  skipped: 0,
  done: 0,
  costUsd: 0,
  active: [],
  completed: [],
  finished: false,
  aborting: false,
};

type UiAction = { type: "events"; events: BenchEvent[] } | { type: "aborting" };

function applyEvent(state: UiState, e: BenchEvent): UiState {
  switch (e.type) {
    case "benchmark-started":
      return { ...state, totalPairs: e.totalPairs, skipped: e.skippedPairs, done: e.skippedPairs };
    case "pair-skipped":
      return state;
    case "pair-started":
      return {
        ...state,
        active: [
          ...state.active,
          {
            pairId: e.pairId,
            questionId: e.questionId,
            model: e.model,
            batch: 0,
            runs: 0,
            failures: 0,
            counts: new Map(),
            costUsd: 0,
          },
        ],
      };
    case "batch-started":
      return {
        ...state,
        active: state.active.map((p) => (p.pairId === e.pairId ? { ...p, batch: e.batch } : p)),
      };
    case "run-finished":
      return {
        ...state,
        costUsd: state.costUsd + e.costUsd,
        active: state.active.map((p) => {
          if (p.pairId !== e.pairId) return p;
          const counts = new Map(p.counts);
          counts.set(e.normalized, (counts.get(e.normalized) ?? 0) + 1);
          return { ...p, runs: p.runs + 1, counts, costUsd: p.costUsd + e.costUsd };
        }),
      };
    case "run-failed":
      return {
        ...state,
        active: state.active.map((p) => (p.pairId === e.pairId ? { ...p, failures: p.failures + 1 } : p)),
      };
    case "pair-finished":
      return {
        ...state,
        done: state.done + 1,
        active: state.active.filter((p) => p.pairId !== e.pairId),
        completed: [
          ...state.completed,
          {
            pairId: e.pairId,
            questionId: e.questionId,
            model: e.model,
            status: e.status,
            runs: e.runs,
            answers: e.answers,
            costUsd: e.costUsd,
          },
        ],
      };
    case "benchmark-finished":
      return { ...state, finished: true };
  }
}

function reducer(state: UiState, action: UiAction): UiState {
  if (action.type === "aborting") return { ...state, aborting: true };
  return action.events.reduce(applyEvent, state);
}

function statusGlyph(status: PairStatus) {
  switch (status) {
    case "consensus":
    case "max-runs":
      return <Text color="green">✓</Text>;
    case "aborted":
      return <Text color="yellow">⚠</Text>;
    case "failed":
      return <Text color="red">✗</Text>;
  }
}

function CompletedRow({ pair }: { pair: CompletedPair }) {
  const summary =
    pair.status === "failed"
      ? "no successful runs"
      : pair.answers.map((a) => `${a.value} ${a.percent}%`).join(", ");
  return (
    <Text>
      {"  "}
      {statusGlyph(pair.status)} {pair.questionId}
      <Text dimColor> × </Text>
      {shortModel(pair.model)}
      <Text dimColor>
        {"  "}({pair.runs} runs) → {summary} · {formatCost(pair.costUsd)}
      </Text>
    </Text>
  );
}

function InterruptHandler({ onInterrupt }: { onInterrupt: () => void }) {
  useInput((input, key) => {
    if (key.ctrl && input === "c") onInterrupt();
  });
  return null;
}

function App({
  queue,
  maxRuns,
  onInterrupt,
}: {
  queue: BenchEvent[];
  maxRuns: number;
  onInterrupt: () => void;
}) {
  const [state, dispatch] = useReducer(reducer, initialState);

  // Flush buffered events every 100ms so run-finished bursts don't cause a
  // render per event.
  useEffect(() => {
    const timer = setInterval(() => {
      if (queue.length > 0) dispatch({ type: "events", events: queue.splice(0) });
    }, 100);
    return () => clearInterval(timer);
  }, [queue]);

  const handleInterrupt = () => {
    dispatch({ type: "aborting" });
    onInterrupt();
  };

  return (
    <Box flexDirection="column">
      {process.stdin.isTTY && <InterruptHandler onInterrupt={handleInterrupt} />}
      <Static items={state.completed}>{(pair) => <CompletedRow key={pair.pairId} pair={pair} />}</Static>
      <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
        <Box>
          <Text bold>artificial-advice </Text>
          <ProgressBar done={state.done} total={state.totalPairs} />
          <Text>
            {" "}
            {state.done}/{state.totalPairs} pairs
          </Text>
          <Text dimColor>
            {state.skipped > 0 ? ` · ${state.skipped} skipped` : ""} · cost {formatCost(state.costUsd)}
          </Text>
        </Box>
        {state.active.map((pair) => (
          <PairRow key={pair.pairId} pair={pair} maxRuns={maxRuns} />
        ))}
        {state.aborting && !state.finished && (
          <Text color="yellow">aborting — draining in-flight runs (ctrl-c again to force quit)</Text>
        )}
        {state.finished && <Text color="green">done</Text>}
      </Box>
    </Box>
  );
}

export function startInkUi({ onInterrupt, maxRuns = 10 }: { onInterrupt: () => void; maxRuns?: number }) {
  const queue: BenchEvent[] = [];
  const instance = render(<App queue={queue} maxRuns={maxRuns} onInterrupt={onInterrupt} />, {
    exitOnCtrlC: false,
  });
  return {
    emit: (e: BenchEvent) => {
      queue.push(e);
    },
    finish: async () => {
      // Give the flush interval one last tick so trailing events render.
      await new Promise((resolve) => setTimeout(resolve, 150));
      instance.unmount();
      await instance.waitUntilExit();
    },
  };
}
