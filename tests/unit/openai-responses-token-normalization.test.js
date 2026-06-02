import { describe, expect, it } from "vitest";
import { openaiToOpenAIResponsesRequest } from "../../open-sse/translator/request/openai-responses.js";

const baseBody = {
  messages: [{ role: "user", content: "hello" }]
};

describe("openaiToOpenAIResponsesRequest token limit normalization", () => {
  it("prefers max_completion_tokens when both token limit fields are present", () => {
    const result = openaiToOpenAIResponsesRequest("gpt-5", {
      ...baseBody,
      max_tokens: 5,
      max_completion_tokens: 11
    }, false);

    expect(result.max_completion_tokens).toBe(11);
    expect(result.max_tokens).toBeUndefined();
  });

  it("passes through max_tokens when max_completion_tokens is absent", () => {
    const result = openaiToOpenAIResponsesRequest("gpt-5", {
      ...baseBody,
      max_tokens: 5
    }, false);

    expect(result.max_tokens).toBe(5);
    expect(result.max_completion_tokens).toBeUndefined();
  });

  it("passes through max_completion_tokens when it is the only token limit", () => {
    const result = openaiToOpenAIResponsesRequest("gpt-5", {
      ...baseBody,
      max_completion_tokens: 11
    }, false);

    expect(result.max_completion_tokens).toBe(11);
    expect(result.max_tokens).toBeUndefined();
  });
});
