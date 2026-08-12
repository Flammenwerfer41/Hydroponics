export const JSON_HEADERS = Object.freeze({
  "Content-Type": "application/json; charset=utf-8",
  "X-Content-Type-Options": "nosniff"
});

export function publicCorsHeaders(
  methods = "GET, OPTIONS",
  allowedHeaders = "Content-Type"
) {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": methods
  };
  if (allowedHeaders) headers["Access-Control-Allow-Headers"] = allowedHeaders;
  return headers;
}

export function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body, null, 2) + "\n", {
    status,
    headers: {
      ...JSON_HEADERS,
      ...headers
    }
  });
}

export function preflightResponse({
  methods = "GET, OPTIONS",
  allowedHeaders = "Content-Type",
  maxAge = 86400,
  headers = {}
} = {}) {
  return new Response(null, {
    status: 204,
    headers: {
      ...publicCorsHeaders(methods, allowedHeaders),
      "Access-Control-Max-Age": String(maxAge),
      ...headers
    }
  });
}
