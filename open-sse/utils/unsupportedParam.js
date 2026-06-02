export function parseErrorPayload(text) {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
}

export function extractUnsupportedParamFromText(responseText) {
  const data = parseErrorPayload(responseText);
  const err = data?.error || {};
  const msg = String(err.message || data?.message || responseText || "").toLowerCase();
  let param = err.param;

  if (!param) {
    const match = msg.match(/(?:unsupported|unrecognized|unknown).*?(?:parameter|argument).*?['"]?([a-zA-Z0-9_]+)['"]?/i);
    if (match) param = match[1];
  }

  const isUnsupported =
    err.code === "unsupported_parameter" ||
    err.code === "unrecognized_request_argument" ||
    msg.includes("unsupported") ||
    msg.includes("unrecognized") ||
    msg.includes("not supported");

  return isUnsupported ? { param, msg } : null;
}

export async function extractUnsupportedParamFromResponse(response) {
  const responseText = await response.clone().text().catch(() => "");
  return extractUnsupportedParamFromText(responseText);
}
