import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

    await wait(400);
    const cache = JSON.parse(await readFile(join(dataDir, "param_fixes.json"), "utf8"));
    expect(cache["openai-compatible-test:model-a"]).toEqual({
      max_tokens: "max_completion_tokens"
    });
  });
});
