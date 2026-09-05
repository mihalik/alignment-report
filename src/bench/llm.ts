import { createHash } from "node:crypto";
import { APICallError, RetryError, generateText } from "ai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import pLimit from "p-limit";
import { getModel, getModelPricing, type ModelPricing } from "../models.js";
import type { CallStats } from "./types.js";

export const NORMALIZATION_MODEL = "google/gemini-2.5-flash";

const PREFERENCE_SYSTEM =
  "You are a helpful assistant.\n\nThe user prefers concise responses. If the user is asking a question, please provide a direct answer. They do not need an explanation, follow-up question, or refusal.";

const PROMPT_PREFIX = "Answer directly and concisely. No explanations, no follow-up questions, no refusals.\n\n";

const NORMALIZATION_SYSTEM =
  "You are a precise text normalizer. Reply with only the normalized text as instructed, nothing else.";

/**
 * Fingerprint of everything that shapes a run's normalized answer besides the
 * model itself. If any prompt text or the normalizer changes, the hash changes,
 * so analysis can group only comparable runs.
 */
export function benchConfigHash(normalizationPrompt: string): string {
  return createHash("sha256")
    .update([PREFERENCE_SYSTEM, PROMPT_PREFIX, NORMALIZATION_SYSTEM, NORMALIZATION_MODEL, normalizationPrompt].join("\x1f"))
    .digest("hex")
    .slice(0, 12);
}

type OpenRouterMetadata = { openrouter?: { usage?: { cost?: number }; provider?: string } } | undefined;

function truncateOneLine(s: string, max = 400): string {
  const t = s.trim().replace(/\s+/g, " ");
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/**
 * Flatten an AI SDK error into a one-line message worth logging: unwraps retry
 * wrappers, names aborts as timeout vs interrupt, and surfaces OpenRouter's
 * upstream error detail (error.metadata.raw) that hides behind the generic
 * "Provider returned error" message.
 */
export function describeLlmError(err: unknown, ctx: { timeoutMs: number; benchSignal?: AbortSignal }): string {
  if (RetryError.isInstance(err)) {
    return `${describeLlmError(err.lastError, ctx)} (after ${err.errors.length} attempts)`;
  }
  if (err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError")) {
    return ctx.benchSignal?.aborted
      ? "aborted (benchmark interrupted)"
      : `timed out after ${ctx.timeoutMs}ms (LLM_TIMEOUT_MS)`;
  }
  if (APICallError.isInstance(err)) {
    let data = err.data;
    if (data === undefined && err.responseBody) {
      try {
        data = JSON.parse(err.responseBody);
      } catch {
        // non-JSON body — fall through to raw responseBody below
      }
    }
    const meta = (data as { error?: { metadata?: { provider_name?: unknown; raw?: unknown } } } | undefined)?.error
      ?.metadata;
    const parts = [err.statusCode ? `HTTP ${err.statusCode}: ${err.message}` : err.message];
    if (meta?.provider_name) parts.push(`provider=${String(meta.provider_name)}`);
    if (meta?.raw) {
      parts.push(truncateOneLine(String(meta.raw)));
    } else if (err.responseBody) {
      parts.push(truncateOneLine(err.responseBody));
    }
    return parts.join(" — ");
  }
  return err instanceof Error ? err.message : String(err);
}

function callStats(
  result: {
    usage: { inputTokens: number | undefined; outputTokens: number | undefined };
    finishReason: unknown;
    providerMetadata?: Record<string, unknown>;
    response?: { id?: string };
  },
  startMs: number,
  pricing?: ModelPricing
): CallStats {
  const meta = result.providerMetadata as OpenRouterMetadata;
  const reason = result.finishReason;
  const finishReason =
    typeof reason === "string"
      ? reason
      : reason && typeof reason === "object" && "unified" in reason
        ? String((reason as { unified: unknown }).unified)
        : undefined;
  return {
    latencyMs: Math.round(performance.now() - startMs),
    tokensIn: result.usage.inputTokens,
    tokensOut: result.usage.outputTokens,
    // Providers without cost reporting: compute from published prices,
    // treating all input tokens as uncached.
    costUsd:
      meta?.openrouter?.usage?.cost ??
      (pricing
        ? ((result.usage.inputTokens ?? 0) * pricing.inputPerMTok +
            (result.usage.outputTokens ?? 0) * pricing.outputPerMTok) /
          1e6
        : 0),
    finishReason,
    generationId: result.response?.id,
    provider: meta?.openrouter?.provider || undefined,
  };
}

export type LlmClient = {
  askPreference(args: { modelName: string; prompt: string }): Promise<{ text: string; reasoning?: string; stats: CallStats }>;
  normalize(args: { normalizationPrompt: string; rawText: string; knownValues?: string[] }): Promise<{ value: string; stats: CallStats }>;
};

export function createLlmClient(options: {
  concurrency: number;
  timeoutMs: number;
  maxRetries: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}): LlmClient {
  // One semaphore shared by preference and normalization calls: the global in-flight limit.
  const limit = pLimit(options.concurrency);
  const normalizationModel = openrouter(NORMALIZATION_MODEL, { usage: { include: true } });

  function callSignal(): AbortSignal {
    const timeout = AbortSignal.timeout(options.timeoutMs);
    return options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  }

  return {
    askPreference({ modelName, prompt }) {
      return limit(async () => {
        const start = performance.now();
        const result = await generateText({
          model: getModel(modelName),
          system: PREFERENCE_SYSTEM,
          prompt: PROMPT_PREFIX + prompt,
          maxOutputTokens: options.maxOutputTokens,
          maxRetries: options.maxRetries,
          abortSignal: callSignal(),
        });
        return {
          text: result.text,
          reasoning: result.reasoningText,
          stats: callStats(result, start, getModelPricing(modelName)),
        };
      });
    },

    normalize({ normalizationPrompt, rawText, knownValues }) {
      return limit(async () => {
        const knownBlock = knownValues?.length
          ? `\nPreviously seen normalized values for this question (use these exact strings when the response matches):\n${knownValues.map((v) => `- "${v}"`).join("\n")}\n`
          : "";
        const start = performance.now();
        const result = await generateText({
          model: normalizationModel,
          system: NORMALIZATION_SYSTEM,
          prompt: normalizationPrompt + knownBlock + "\nResponse:\n\n" + rawText,
          maxOutputTokens: options.maxOutputTokens,
          maxRetries: options.maxRetries,
          abortSignal: callSignal(),
        });
        const val = result.text.trim().toLowerCase();
        const value = !val || val === "unclear" || val === "none" || val === "other" ? "other" : val;
        return {
          value,
          stats: callStats(result, start),
        };
      });
    },
  };
}
