import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PARAM_CACHE_TIMEOUT_MS = 2000;
const PARAM_CACHE_POLL_MS = 25;

async function readParamCacheUntil(dataDir, key, expectedValue) {
  const filePath = join(dataDir, "param_fixes.json");
  const deadline = Date.now() + PARAM_CACHE_TIMEOUT_MS;
  let lastError;

  while (Date.now() < deadline) {
    try {
      const cache = JSON.parse(await readFile(filePath, "utf8"));
      if (JSON.stringify(cache[key]) === JSON.stringify(expectedValue)) return cache;
    } catch (error) {
      lastError = error;
    }
    await sleep(PARAM_CACHE_POLL_MS);
  }

  throw new Error(`Timed out waiting for ${key} in param_fixes.json${lastError ? `: ${lastError.message}` : ""}`);
}

describe("BaseExecutor parameter cache persistence", () => {
  let dataDir;
  let previousDataDir;

  afterEach(async () => {
    vi.doUnmock("../../open-sse/utils/proxyFetch.js");
    vi.resetModules();
    if (previousDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = previousDataDir;
    if (dataDir) await rm(dataDir, { recursive: true, force: true });
    dataDir = null;
  });

  it("persists learned fixes asynchronously after retrying with replacement token param", async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = await mkdtemp(join(tmpdir(), "9router-param-cache-"));
    process.env.DATA_DIR = dataDir;

    const proxyAwareFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        error: {
          code: "unsupported_parameter",
          param: "max_tokens",
          message: "Unsupported parameter: max_tokens. Use max_completion_tokens instead."
        }
      }), { status: 400, headers: { "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));

    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

    const { BaseExecutor } = await import("../../open-sse/executors/base.js");
    const executor = new BaseExecutor("openai-compatible-test", { baseUrl: "https://example.test/v1" });
    const body = { messages: [], max_tokens: 5 };

    const result = await executor.execute({
      model: "model-a",
      body,
      stream: false,
      credentials: { apiKey: "test-key" },
      log: null
    });

    expect(result.response.status).toBe(200);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(proxyAwareFetch.mock.calls[1][1].body)).toEqual({
      messages: [],
      max_completion_tokens: 5
    });
    expect(body).toEqual({ messages: [], max_tokens: 5 });

    const cache = await readParamCacheUntil(dataDir, "openai-compatible-test:model-a", {
      max_tokens: "max_completion_tokens"
    });
    expect(cache["openai-compatible-test:model-a"]).toEqual({
      max_tokens: "max_completion_tokens"
    });
    expect((await readdir(dataDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("learns replacement token params from plain-text unsupported-parameter errors", async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = await mkdtemp(join(tmpdir(), "9router-param-cache-"));
    process.env.DATA_DIR = dataDir;

    const proxyAwareFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(
        "Unsupported parameter: max_tokens. Use max_completion_tokens instead.",
        { status: 400, headers: { "Content-Type": "text/plain" } }
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      }));

    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

    const { BaseExecutor } = await import("../../open-sse/executors/base.js");
    const executor = new BaseExecutor("openai-compatible-test", { baseUrl: "https://example.test/v1" });

    const result = await executor.execute({
      model: "model-a",
      body: { messages: [], max_tokens: 5 },
      stream: false,
      credentials: { apiKey: "test-key" },
      log: null
    });

    expect(result.response.status).toBe(200);
    expect(proxyAwareFetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(proxyAwareFetch.mock.calls[1][1].body)).toEqual({
      messages: [],
      max_completion_tokens: 5
    });

    const cache = await readParamCacheUntil(dataDir, "openai-compatible-test:model-a", {
      max_tokens: "max_completion_tokens"
    });
    expect(cache["openai-compatible-test:model-a"]).toEqual({
      max_tokens: "max_completion_tokens"
    });
  });

  it("preserves an already-present replacement param when applying cached fixes", async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = await mkdtemp(join(tmpdir(), "9router-param-cache-"));
    process.env.DATA_DIR = dataDir;
    await writeFile(join(dataDir, "param_fixes.json"), JSON.stringify({
      "openai-compatible-test:model-a": {
        max_tokens: "max_completion_tokens"
      }
    }));

    const proxyAwareFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));

    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

    const { BaseExecutor } = await import("../../open-sse/executors/base.js");
    const executor = new BaseExecutor("openai-compatible-test", { baseUrl: "https://example.test/v1" });
    const body = { messages: [], max_tokens: 5, max_completion_tokens: 11 };

    await executor.execute({
      model: "model-a",
      body,
      stream: false,
      credentials: { apiKey: "test-key" },
      log: null
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(proxyAwareFetch.mock.calls[0][1].body)).toEqual({
      messages: [],
      max_completion_tokens: 11
    });
    expect(body).toEqual({ messages: [], max_tokens: 5, max_completion_tokens: 11 });
  });

  it("applies cached fixes before transformRequest derives provider-specific fields", async () => {
    previousDataDir = process.env.DATA_DIR;
    dataDir = await mkdtemp(join(tmpdir(), "9router-param-cache-"));
    process.env.DATA_DIR = dataDir;
    await writeFile(join(dataDir, "param_fixes.json"), JSON.stringify({
      "openai-compatible-test:model-a": {
        max_tokens: "max_completion_tokens"
      }
    }));

    const proxyAwareFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));

    vi.doMock("../../open-sse/utils/proxyFetch.js", () => ({ proxyAwareFetch }));

    const { BaseExecutor } = await import("../../open-sse/executors/base.js");
    class DerivedParamExecutor extends BaseExecutor {
      transformRequest(model, body) {
        if (body.max_tokens !== undefined) {
          return { providerParams: { unsupportedMaxTokens: body.max_tokens } };
        }
        return { providerParams: { supportedMaxCompletionTokens: body.max_completion_tokens } };
      }
    }

    const executor = new DerivedParamExecutor("openai-compatible-test", { baseUrl: "https://example.test/v1" });
    const body = { messages: [], max_tokens: 5 };

    await executor.execute({
      model: "model-a",
      body,
      stream: false,
      credentials: { apiKey: "test-key" },
      log: null
    });

    expect(proxyAwareFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(proxyAwareFetch.mock.calls[0][1].body)).toEqual({
      providerParams: { supportedMaxCompletionTokens: 5 }
    });
    expect(body).toEqual({ messages: [], max_tokens: 5 });
  });
});
