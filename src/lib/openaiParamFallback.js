import { extractUnsupportedParamFromText } from "../../open-sse/utils/unsupportedParam.js";

export const OPENAI_STYLE_PROBE_MAX_TOKENS = 64;

async function getTokenFallbackPayload(response, payload) {
  if (response.status !== 400 || !payload || typeof payload !== "object") {
    return null;
  }

  const responseText = await response.clone().text().catch(() => "");
  const unsupported = extractUnsupportedParamFromText(responseText);
  if (!unsupported) return null;

  const { param, msg } = unsupported;
  const hasMaxTokens = payload.max_tokens !== undefined;
  const hasMaxCompletionTokens = payload.max_completion_tokens !== undefined;

  if (hasMaxTokens && !hasMaxCompletionTokens && (param === "max_tokens" || msg.includes("max_completion_tokens"))) {
    const nextPayload = { ...payload, max_completion_tokens: payload.max_tokens };
    delete nextPayload.max_tokens;
    return nextPayload;
  }

  if (hasMaxCompletionTokens && !hasMaxTokens && (param === "max_completion_tokens" || msg.includes("max_tokens"))) {
    const nextPayload = { ...payload, max_tokens: payload.max_completion_tokens };
    delete nextPayload.max_completion_tokens;
    return nextPayload;
  }

  return null;
}

export async function fetchOpenAIStyleWithTokenFallback(fetcher, url, options = {}, payload) {
  const buildOptions = (body) => ({
    ...options,
    body: JSON.stringify(body)
  });

  const firstResponse = await fetcher(url, buildOptions(payload));
  const fallbackPayload = await getTokenFallbackPayload(firstResponse, payload);
  if (!fallbackPayload) return firstResponse;

  return fetcher(url, buildOptions(fallbackPayload));
}
