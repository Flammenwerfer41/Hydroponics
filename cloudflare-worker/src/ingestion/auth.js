const TOKEN_PATTERN = /^[A-Za-z0-9._~-]{24,256}$/;

export async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function authenticateDevice(request, database) {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match || !TOKEN_PATTERN.test(match[1])) return null;

  const secretHash = await sha256Hex(match[1]);
  return database.prepare(`
    SELECT
      c.id AS credential_id,
      c.device_id AS device_id
    FROM device_credentials c
    JOIN devices d ON d.id = c.device_id
    WHERE c.secret_sha256 = ?1
      AND c.revoked_at IS NULL
      AND d.active = 1
    LIMIT 1
  `).bind(secretHash).first();
}

