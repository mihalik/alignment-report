import { openrouter } from "@openrouter/ai-sdk-provider";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

export type ModelPricing = {
  /** USD per 1M input tokens (uncached rate). */
  inputPerMTok: number;
  /** USD per 1M output tokens. */
  outputPerMTok: number;
};

export type ModelEntry = {
  /** Provider model id (also used as the model's name in results files). */
  id: string;
  /** Public release date (YYYY-MM-DD, from OpenRouter's created timestamp). */
  released?: string;
  /** Excluded from the site display (preview/cloaked models). */
  hidden?: boolean;
  /**
   * API to call instead of OpenRouter. Temporary escape hatch for models not
   * yet on OpenRouter; remove the override once OpenRouter carries the model
   * (note: the results-file name would change to the OpenRouter id).
   */
  provider?: "meta";
  /**
   * Published prices for providers that don't report cost per response
   * (OpenRouter does, so entries without a provider override don't need this).
   */
  pricing?: ModelPricing;
};

// Models to benchmark, grouped by company, newest first within each group.
// Comment/uncomment entries to enable/disable. The company string is written
// into results files — don't rename groups without migrating existing data.
const registry: Record<string, ModelEntry[]> = {
  Anthropic: [
    { id: "anthropic/claude-opus-5", released: "2026-07-24" },
    { id: "anthropic/claude-sonnet-5", released: "2026-06-30" },
    { id: "anthropic/claude-fable-5", released: "2026-06-09" },
    { id: "anthropic/claude-opus-4.8", released: "2026-05-27" },
    { id: "anthropic/claude-opus-4.7", released: "2026-04-16" },
    { id: "anthropic/claude-sonnet-4.6", released: "2026-02-17" },
    { id: "anthropic/claude-opus-4.6", released: "2026-02-04" },
    { id: "anthropic/claude-haiku-4.5", released: "2025-10-15" },
    { id: "anthropic/claude-sonnet-4.5", released: "2025-09-29" },
  ],
  OpenAI: [
    { id: "openai/gpt-5.6-luna", released: "2026-07-09" },
    { id: "openai/gpt-5.6-terra", released: "2026-07-09" },
    { id: "openai/gpt-5.6-sol", released: "2026-07-09" },
    { id: "openai/gpt-5.5", released: "2026-04-24" },
    { id: "openai/gpt-5.4-nano", released: "2026-03-17" },
    { id: "openai/gpt-5.4-mini", released: "2026-03-17" },
    { id: "openai/gpt-5.4", released: "2026-03-05" },
    { id: "openai/gpt-5.3-chat", released: "2026-03-03" },
    { id: "openai/gpt-oss-120b", released: "2025-08-05" },
    { id: "openai/gpt-4.1-mini", released: "2025-04-14" },
    // { id: "oopenai/gpt-4o-2024-08-06", released: "2024-08-06" },
    { id: "openai/gpt-4o-mini", released: "2024-07-17" },
    // { id: "openai/gpt-5.2" },
  ],
  Google: [
    { id: "google/gemini-3.6-flash", released: "2026-07-21" },
    { id: "google/gemini-3.6-flash-lite", released: "2026-07-21" },
    { id: "google/gemini-3.5-flash", released: "2026-05-19" },
    { id: "google/gemini-3.1-flash-lite", released: "2026-05-07" },
    { id: "google/gemma-4-26b-a4b-it", released: "2026-04-03" },
    { id: "google/gemma-4-31b-it", released: "2026-04-02" },
    { id: "google/gemini-3-flash-preview", released: "2025-12-17" },
    { id: "google/gemini-2.5-flash-lite", released: "2025-07-22" },
    { id: "google/gemini-2.5-flash", released: "2025-06-17" },
    // { id: "google/gemini-3.1-pro-preview" },
  ],
  Meta: [
    // Direct Meta Model API (not on OpenRouter yet); prices from
    // https://dev.meta.ai/docs/getting-started/pricing-rate-limits
    // {
    //   id: "muse-spark-1.1",
    //   released: "2026-07-09",
    //   provider: "meta",
    //   pricing: { inputPerMTok: 1.25, outputPerMTok: 4.25 },
    // },
    { id: "meta/muse-spark-1.1", released: "2026-07-16" },
  ],
  xAI: [
    { id: "x-ai/grok-4.5", released: "2026-07-08" },
    { id: "x-ai/grok-4.3", released: "2026-04-30" },
    { id: "x-ai/grok-4.20", released: "2026-03-31" },
  ],
  DeepSeek: [
    { id: "deepseek/deepseek-v4-pro", released: "2026-04-23" },
    { id: "deepseek/deepseek-v4-flash", released: "2026-04-23" },
    { id: "deepseek/deepseek-v3.2", released: "2025-12-01" },
  ],
  Qwen: [
    { id: "qwen/qwen3.7-plus", released: "2026-06-03" },
    { id: "qwen/qwen3.7-max", released: "2026-05-21" },
    { id: "qwen/qwen3.6-flash", released: "2026-04-26" },
    { id: "qwen/qwen3.6-max-preview", released: "2026-04-26" },
    { id: "qwen/qwen3.6-27b", released: "2026-04-26" },
    { id: "qwen/qwen3.6-plus", released: "2026-04-02" },
    { id: "qwen/qwen3.5-122b-a10b", released: "2026-02-25" },
    { id: "qwen/qwen3.5-flash-02-23", released: "2026-02-25" },
    { id: "qwen/qwen3-235b-a22b-2507", released: "2025-07-21" },
  ],
  "Z.ai": [
    { id: "z-ai/glm-5.2", released: "2026-06-16" },
    { id: "z-ai/glm-5.1", released: "2026-04-07" },
    { id: "z-ai/glm-5-turbo", released: "2026-03-15" },
    { id: "z-ai/glm-5", released: "2026-02-11" },
    { id: "z-ai/glm-4.7-flash", released: "2026-01-19" },
    { id: "z-ai/glm-4.7", released: "2025-12-21" },
  ],
  MoonshotAI: [
    { id: "moonshotai/kimi-k3", released: "2026-07-16" },
    { id: "moonshotai/kimi-k2.7-code", released: "2026-06-12" },
    { id: "moonshotai/kimi-k2.6", released: "2026-04-20" },
    { id: "moonshotai/kimi-k2.5", released: "2026-01-26" },
  ],
  MiniMax: [
    { id: "minimax/minimax-m3", released: "2026-05-31" },
    { id: "minimax/minimax-m2.7", released: "2026-03-18" },
    { id: "minimax/minimax-m2.5", released: "2026-02-12" },
    { id: "minimax/minimax-m2.1", released: "2025-12-22" },
  ],
  Mistral: [
    { id: "mistralai/mistral-small-2603", released: "2026-03-16" },
    { id: "mistralai/mistral-small-3.2-24b-instruct", released: "2025-06-20" },
    { id: "mistralai/mistral-nemo", released: "2024-07-18" },
  ],
  Xiaomi: [
    { id: "xiaomi/mimo-v2.5-pro", released: "2026-04-22" },
    { id: "xiaomi/mimo-v2.5", released: "2026-04-22" },
  ],
  NVIDIA: [
    { id: "nvidia/nemotron-3-ultra-550b-a55b", released: "2026-06-04" },
    { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free", released: "2026-04-28", hidden: true },
  ],
  ThinkingMachines: [
    { id: "thinkingmachines/inkling", released: "2026-07-17" },
  ],
  StepFun: [
    { id: "stepfun/step-3.7-flash", released: "2026-05-28" },
    // { id: "stepfun/step-3.5-flash", released: "2026-01-29" },
  ],
  IBM: [
    { id: "ibm-granite/granite-4.1-8b", released: "2026-04-30" },
  ],
  Sakana: [
    { id: "sakana/fugu-ultra", released: "2026-06-23" },
  ],
  "Arcee AI": [
    { id: "arcee-ai/trinity-large-thinking", released: "2026-04-01" },
  ],
  Tencent: [
    { id: "tencent/hy3", released: "2026-06-26" },
  ],
  // Cloaked preview models; company labels match what's in existing results files.
  Secret: [
    // { id: "openrouter/owl-alpha", hidden: true },       // preview ended
  ],
};

export type ModelInfo = { name: string; company: string; released?: string; hidden?: boolean };

export function listModels(): ModelInfo[] {
  return Object.entries(registry).flatMap(([company, models]) =>
    models.map((m) => ({ name: m.id, company, released: m.released, hidden: m.hidden }))
  );
}

let metaProvider: ReturnType<typeof createOpenAICompatible> | undefined;

function getMetaProvider() {
  if (!process.env.META_API_KEY) throw new Error("META_API_KEY is required for Meta models");
  return (metaProvider ??= createOpenAICompatible({
    name: "meta",
    baseURL: "https://api.meta.ai/v1",
    apiKey: process.env.META_API_KEY,
  }));
}

function findEntry(name: string): ModelEntry {
  const found = Object.values(registry)
    .flat()
    .find((m) => m.id === name);
  if (!found) throw new Error(`Unknown model: ${name}`);
  return found;
}

export function getModel(name: string): LanguageModel {
  const found = findEntry(name);
  if (found.provider === "meta") return getMetaProvider()(found.id);
  return openrouter(found.id, { usage: { include: true } });
}

/** Published prices for models whose API doesn't report cost per response. */
export function getModelPricing(name: string): ModelPricing | undefined {
  return findEntry(name).pricing;
}
