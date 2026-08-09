function decodePart(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return JSON.parse(atob(padded));
}

function signatureBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function teamIssuer(environment) {
  const domain = environment.CF_ACCESS_TEAM_DOMAIN;
  if (!domain) return null;
  const host = domain.includes(".") ? domain : `${domain}.cloudflareaccess.com`;
  return `https://${host}`;
}

async function accessKeys(issuer) {
  const response = await fetch(`${issuer}/cdn-cgi/access/certs`, {
    cf: { cacheEverything: true, cacheTtl: 3600 }
  });
  if (!response.ok) throw new Error(`Access certificates returned HTTP ${response.status}`);
  return response.json();
}

function hasAudience(payload, expected) {
  const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  return audiences.includes(expected);
}

export async function authenticateAdmin(request, environment) {
  const issuer = teamIssuer(environment);
  const audience = environment.CF_ACCESS_AUD;
  if (!issuer || !audience) return null;
  const token = request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  try {
    const header = decodePart(parts[0]);
    const payload = decodePart(parts[1]);
    if (header.alg !== "RS256" || !header.kid) return null;
    if (payload.iss !== issuer || !hasAudience(payload, audience)) return null;
    const now = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(payload.exp) || payload.exp <= now) return null;
    if (Number.isFinite(payload.nbf) && payload.nbf > now + 30) return null;

    const certificates = await accessKeys(issuer);
    const jwk = certificates.keys?.find((candidate) => candidate.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
    const valid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      signatureBytes(parts[2]),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    );
    if (!valid) return null;
    return {
      id: payload.email || payload.sub || "access-user",
      email: payload.email || null,
      subject: payload.sub || null
    };
  } catch (error) {
    console.warn("Cloudflare Access token validation failed", error);
    return null;
  }
}
