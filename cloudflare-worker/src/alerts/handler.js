import { activePublicAlerts } from "./store.js";
import { jsonResponse, preflightResponse, publicCorsHeaders } from "../http/response.js";

function response(body, status = 200) {
  return jsonResponse(body, status, {
    "Cache-Control": "public, max-age=30",
    ...publicCorsHeaders("GET, OPTIONS", "")
  });
}

export async function handlePublicAlerts(request, environment) {
  if (request.method === "OPTIONS") return preflightResponse({ allowedHeaders: "" });
  if (request.method !== "GET") return response({ error: "Method not allowed" }, 405);
  if (!environment.HYDROPONICS_DB) return response({ error: "Database unavailable" }, 503);
  const alerts = await activePublicAlerts(environment.HYDROPONICS_DB);
  return response({
    schema_version: 1,
    generated_at: new Date().toISOString(),
    active_count: alerts.length,
    highest_severity: alerts.some(({ severity }) => severity === "critical")
      ? "critical" : alerts.length ? "warning" : null,
    alerts
  });
}
