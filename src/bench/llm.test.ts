import { describe, it, expect } from "vitest";
import { APICallError, RetryError } from "ai";
import { describeLlmError } from "./llm.js";

const ctx = { timeoutMs: 60_000 };

function openRouterError(body: unknown, statusCode = 429) {
  return new APICallError({
    message: "Provider returned error",
    url: "https://openrouter.ai/api/v1/chat/completions",
    requestBodyValues: {},
    statusCode,
    responseBody: JSON.stringify(body),
  });
}

describe("describeLlmError", () => {
  it("surfaces OpenRouter upstream detail from error.metadata.raw", () => {
    const err = openRouterError({
      error: {
        message: "Provider returned error",
        code: 429,
        metadata: { provider_name: "Moonshot", raw: "rate limit exceeded, please retry later" },
      },
    });
    expect(describeLlmError(err, ctx)).toBe(
      "HTTP 429: Provider returned error — provider=Moonshot — rate limit exceeded, please retry later"
    );
  });

  it("falls back to the response body when there is no metadata.raw", () => {
    const err = openRouterError({ error: { message: "Insufficient credits", code: 402 } }, 402);
    expect(describeLlmError(err, ctx)).toBe(
      'HTTP 402: Provider returned error — {"error":{"message":"Insufficient credits","code":402}}'
    );
  });

  it("unwraps RetryError to the last error and notes attempts", () => {
    const inner = openRouterError({ error: { metadata: { raw: "overloaded" } } }, 503);
    const err = new RetryError({
      message: "Failed after 3 attempts",
      reason: "maxRetriesExceeded",
      errors: [inner, inner, inner],
    });
    expect(describeLlmError(err, ctx)).toBe("HTTP 503: Provider returned error — overloaded (after 3 attempts)");
  });

  it("reports timeouts with the configured limit", () => {
    const abort = new DOMException("This operation was aborted", "AbortError");
    expect(describeLlmError(abort, ctx)).toBe("timed out after 60000ms (LLM_TIMEOUT_MS)");
    const timeout = new DOMException("The operation was aborted due to timeout", "TimeoutError");
    expect(describeLlmError(timeout, ctx)).toBe("timed out after 60000ms (LLM_TIMEOUT_MS)");
  });

  it("reports aborts as interrupts when the benchmark signal fired", () => {
    const controller = new AbortController();
    controller.abort();
    const abort = new DOMException("This operation was aborted", "AbortError");
    expect(describeLlmError(abort, { ...ctx, benchSignal: controller.signal })).toBe(
      "aborted (benchmark interrupted)"
    );
  });

  it("passes through plain errors", () => {
    expect(describeLlmError(new Error("boom"), ctx)).toBe("boom");
    expect(describeLlmError("weird", ctx)).toBe("weird");
  });
});
