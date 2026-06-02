import { HTTP_STATUS, DEFAULT_RETRY_CONFIG, resolveRetryEntry, FETCH_CONNECT_TIMEOUT_MS } from "../config/runtimeConfig.js";
import { proxyAwareFetch } from "../utils/proxyFetch.js";
import { dbg } from "../utils/debugLog.js";

const isNode = typeof process !== "undefined" && process.versions?.node && typeof window === "undefined";
const isNextBuildPhase = isNode && (
  process.env.NEXT_PHASE === "phase-production-build" ||
  process.env.NEXT_PHASE === "phase-export" ||
  process.env.NEXT_PHASE === "phase-static"
);
let fs = null;
let cacheFilePath = null;

// Cache learned unsupported parameter fixes.
// Format: "provider:model" -> { "max_tokens": "max_completion_tokens", "temperature": null }
const paramFixCache = new Map();

async function initParamCache() {
  if (!isNode || isNextBuildPhase || fs) return;

  try {
    fs = await import("fs");

    const dataDir = process.env.DATA_DIR || (
      process.platform === "win32"
        ? joinPath(process.env.APPDATA || process.env.USERPROFILE || process.cwd(), "9router")
        : joinPath(process.env.HOME || process.cwd(), ".9router")
    );

    if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
    cacheFilePath = joinPath(dataDir, "param_fixes.json");

    if (fs.existsSync(cacheFilePath)) {
      const data = JSON.parse(fs.readFileSync(cacheFilePath, "utf8"));
      for (const [key, value] of Object.entries(data)) {
        paramFixCache.set(key, value);
      }
      dbg("CACHE", `Loaded ${paramFixCache.size} param fixes from disk`);
    }
  } catch (error) {
    dbg("CACHE", `Failed to load param cache: ${error.message}`);
  }
}

function joinPath(...parts) {
  const separator = process.platform === "win32" ? "\\" : "/";
  return parts
    .filter(Boolean)
    .map((part, index) => {
      const normalized = String(part);
      if (index === 0) return normalized.replace(/[\\/]+$/, "");
      return normalized.replace(/^[\\/]+|[\\/]+$/g, "");
    })
    .join(separator);
}

function saveParamCache() {
  if (!fs || !cacheFilePath) return;

  try {
    const data = Object.fromEntries(paramFixCache.entries());
    fs.writeFileSync(cacheFilePath, JSON.stringify(data, null, 2));
  } catch (error) {
    dbg("CACHE", `Failed to save param cache: ${error.message}`);
  }
}

const paramCacheReady = initParamCache();

/**
 * BaseExecutor - Base class for provider executors
 */
export class BaseExecutor {
  constructor(provider, config) {
    this.provider = provider;
    this.config = config;
    this.noAuth = config?.noAuth || false;
  }

  getProvider() {
    return this.provider;
  }

  getBaseUrls() {
    return this.config.baseUrls || (this.config.baseUrl ? [this.config.baseUrl] : []);
  }

  getFallbackCount() {
    return this.getBaseUrls().length || 1;
  }

  buildUrl(model, stream, urlIndex = 0, credentials = null) {
    if (this.provider?.startsWith?.("openai-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "https://api.openai.com/v1";
      const normalized = baseUrl.replace(/\/$/, "");
      const path = this.provider.includes("responses") ? "/responses" : "/chat/completions";
      return `${normalized}${path}`;
    }
    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      const baseUrl = credentials?.providerSpecificData?.baseUrl || "https://api.anthropic.com/v1";
      const normalized = baseUrl.replace(/\/$/, "");
      return `${normalized}/messages`;
    }
    const baseUrls = this.getBaseUrls();
    return baseUrls[urlIndex] || baseUrls[0] || this.config.baseUrl;
  }

  buildHeaders(credentials, stream = true) {
    const headers = {
      "Content-Type": "application/json",
      ...this.config.headers
    };

    if (this.provider?.startsWith?.("anthropic-compatible-")) {
      // Anthropic-compatible providers use x-api-key header
      if (credentials.apiKey) {
        headers["x-api-key"] = credentials.apiKey;
      } else if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      }
      if (!headers["anthropic-version"]) {
        headers["anthropic-version"] = "2023-06-01";
      }
    } else {
      // Standard Bearer token auth for other providers
      if (credentials.accessToken) {
        headers["Authorization"] = `Bearer ${credentials.accessToken}`;
      } else if (credentials.apiKey) {
        headers["Authorization"] = `Bearer ${credentials.apiKey}`;
      }
    }

    if (stream) {
      headers["Accept"] = "text/event-stream";
    }

    return headers;
  }

  // Override in subclass for provider-specific transformations
  transformRequest(model, body, stream, credentials) {
    return body;
  }

  shouldRetry(status, urlIndex) {
    return status === HTTP_STATUS.RATE_LIMITED && urlIndex + 1 < this.getFallbackCount();
  }

  // Override in subclass for provider-specific refresh
  async refreshCredentials(credentials, log, proxyOptions = null) {
    return null;
  }

  needsRefresh(credentials) {
    if (!credentials.expiresAt) return false;
    const expiresAtMs = new Date(credentials.expiresAt).getTime();
    return expiresAtMs - Date.now() < 5 * 60 * 1000;
  }

  parseError(response, bodyText) {
    return { status: response.status, message: bodyText || `HTTP ${response.status}` };
  }

  applyCachedParamFixes(cacheKey, body, transformedBody) {
    const fixes = paramFixCache.get(cacheKey);
    if (!fixes) return;

    for (const [badParam, goodParam] of Object.entries(fixes)) {
      if (body[badParam] !== undefined) {
        if (goodParam) body[goodParam] = body[badParam];
        delete body[badParam];
      }

      if (transformedBody && transformedBody[badParam] !== undefined) {
        if (goodParam) transformedBody[goodParam] = transformedBody[badParam];
        delete transformedBody[badParam];
      }
    }
  }

  learnUnsupportedParamFix(cacheKey, param, msg, body, transformedBody, log) {
    if (!paramFixCache.has(cacheKey)) paramFixCache.set(cacheKey, {});
    const modelFixes = paramFixCache.get(cacheKey);

    if (param === "max_tokens" && msg.includes("max_completion_tokens") && transformedBody.max_tokens !== undefined) {
      log?.debug?.("RETRY", "400 unsupported max_tokens, caching and retrying with max_completion_tokens");
      modelFixes.max_tokens = "max_completion_tokens";
      body.max_completion_tokens = body.max_tokens ?? transformedBody.max_tokens;
      delete body.max_tokens;
      saveParamCache();
      return true;
    }

    if (param === "max_completion_tokens" && msg.includes("max_tokens") && transformedBody.max_completion_tokens !== undefined) {
      log?.debug?.("RETRY", "400 unsupported max_completion_tokens, caching and retrying with max_tokens");
      modelFixes.max_completion_tokens = "max_tokens";
      body.max_tokens = body.max_completion_tokens ?? transformedBody.max_completion_tokens;
      delete body.max_completion_tokens;
      saveParamCache();
      return true;
    }

    if (transformedBody[param] !== undefined) {
      log?.debug?.("RETRY", `400 unsupported ${param}, caching and retrying without it`);
      modelFixes[param] = null;
      delete body[param];
      saveParamCache();
      return true;
    }

    return false;
  }

  async tryAutoFixBadRequest(response, cacheKey, body, transformedBody, autoFixedParams, log) {
    if (response.status !== HTTP_STATUS.BAD_REQUEST || !transformedBody || typeof transformedBody !== "object") {
      return false;
    }

    try {
      const errBody = await response.clone().json();
      const err = errBody?.error || {};
      const msg = (err.message || "").toLowerCase();
      const errCode = err.code;
      let param = err.param;

      if (!param) {
        const match = msg.match(/(?:unsupported|unrecognized|unknown).*?(?:parameter|argument).*?['"]?([a-zA-Z0-9_]+)['"]?/i);
        if (match) param = match[1];
      }

      const isUnsupported =
        errCode === "unsupported_parameter" ||
        errCode === "unrecognized_request_argument" ||
        msg.includes("unsupported") ||
        msg.includes("unrecognized") ||
        msg.includes("not supported");

      if (!isUnsupported || !param || typeof param !== "string" || autoFixedParams.has(param)) {
        return false;
      }

      autoFixedParams.add(param);
      return this.learnUnsupportedParamFix(cacheKey, param, msg, body, transformedBody, log);
    } catch {
      return false;
    }
  }

  async execute({ model, body, stream, credentials, signal, log, proxyOptions = null }) {
    await paramCacheReady;

    const fallbackCount = this.getFallbackCount();
    let lastError = null;
    let lastStatus = 0;
    const retryAttemptsByUrl = {};

    const cacheKey = `${this.provider}:${model}`;
    const autoFixedParams = new Set();
    const retryConfig = { ...DEFAULT_RETRY_CONFIG, ...this.config.retry };

    // Schedule retry via retryConfig[statusKey]. Returns true when caller should `urlIndex--; continue`
    const tryRetry = async (urlIndex, statusKey, reason) => {
      const { attempts, delayMs } = resolveRetryEntry(retryConfig[statusKey]);
      if (attempts <= 0 || retryAttemptsByUrl[urlIndex] >= attempts) return false;
      retryAttemptsByUrl[urlIndex]++;
      log?.debug?.("RETRY", `${reason} retry ${retryAttemptsByUrl[urlIndex]}/${attempts} after ${delayMs / 1000}s`);
      await new Promise(resolve => setTimeout(resolve, delayMs));
      return true;
    };

    for (let urlIndex = 0; urlIndex < fallbackCount; urlIndex++) {
      const url = this.buildUrl(model, stream, urlIndex, credentials);
      const transformedBody = this.transformRequest(model, body, stream, credentials);
      this.applyCachedParamFixes(cacheKey, body, transformedBody);
      const headers = this.buildHeaders(credentials, stream);

      if (!retryAttemptsByUrl[urlIndex]) retryAttemptsByUrl[urlIndex] = 0;

      // Abort if upstream doesn't return response headers within FETCH_CONNECT_TIMEOUT_MS
      const connectCtrl = new AbortController();
      const connectTimer = setTimeout(() => connectCtrl.abort(new Error("fetch connect timeout")), FETCH_CONNECT_TIMEOUT_MS);
      const mergedSignal = signal ? AbortSignal.any([signal, connectCtrl.signal]) : connectCtrl.signal;

      try {
        const bodyStr = JSON.stringify(transformedBody);
        const fetchT0 = Date.now();
        dbg("FETCH", `${this.provider.toUpperCase()} -> ${url} | body=${bodyStr.length}B | connectTimeout=${FETCH_CONNECT_TIMEOUT_MS}ms`);
        const response = await proxyAwareFetch(url, {
          method: "POST",
          headers,
          body: bodyStr,
          signal: mergedSignal
        }, proxyOptions);
        clearTimeout(connectTimer);
        const ct = response.headers?.get?.("content-type") || "";
        const cl = response.headers?.get?.("content-length") || "?";
        dbg("FETCH", `${this.provider.toUpperCase()} <- ${response.status} | ttft=${Date.now() - fetchT0}ms | ct=${ct} | cl=${cl}`);

        if (await this.tryAutoFixBadRequest(response, cacheKey, body, transformedBody, autoFixedParams, log)) {
          urlIndex--;
          continue;
        }

        if (await tryRetry(urlIndex, response.status, `status ${response.status}`)) { urlIndex--; continue; }

        if (this.shouldRetry(response.status, urlIndex)) {
          log?.debug?.("RETRY", `${response.status} on ${url}, trying fallback ${urlIndex + 1}`);
          lastStatus = response.status;
          continue;
        }

        return { response, url, headers, transformedBody };
      } catch (error) {
        clearTimeout(connectTimer);
        lastError = error;
        const isConnectTimeout = connectCtrl.signal.aborted && error.name === "AbortError";
        dbg("FETCH", `${this.provider.toUpperCase()} x ${error.name}: ${error.message}${isConnectTimeout ? " (connect timeout)" : ""}`);
        // Connect timeout is internal — convert to retryable network error, don't propagate AbortError
        if (error.name === "AbortError" && !isConnectTimeout) throw error;

        // Map network/fetch exceptions to 502 retry config
        if (await tryRetry(urlIndex, HTTP_STATUS.BAD_GATEWAY, `network "${error.message}"`)) { urlIndex--; continue; }

        if (urlIndex + 1 < fallbackCount) {
          log?.debug?.("RETRY", `Error on ${url}, trying fallback ${urlIndex + 1}`);
          continue;
        }
        throw error;
      }
    }

    throw lastError || new Error(`All ${fallbackCount} URLs failed with status ${lastStatus}`);
  }
}

export default BaseExecutor;
