import { describe, expect, it, vi } from "vitest";
import {
  OPENAI_STYLE_PROBE_MAX_TOKENS,
  fetchOpenAIStyleWithTokenFallback
} from "../../src/lib/openaiParamFallback.js";

describe("fetchOpenAIStyleWithTokenFallback", () => {
  it("keeps validation probes high enough to avoid output-limit false negatives", () => {
    expect(OPENAI_STYLE_PROBE_MAX_TOKENS).toBe(64);
  });

  it("uses the shared unsupported-param parser for plain-text fallback errors", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(
        "Unsupported parameter: max_tokens. Use max_completion_tokens instead.",
        { status: 400, headers: { "Content-Type": "text/plain" } }
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));

    const response = await fetchOpenAIStyleWithTokenFallback(fetcher, "https://example.test/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" }
    }, {
      messages: [{ role: "user", content: "ping" }],
      max_tokens: 64
    });

    expect(response.status).toBe(200);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
      messages: [{ role: "user", content: "ping" }],
      max_completion_tokens: 64
    });
  });
});
