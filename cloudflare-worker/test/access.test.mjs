import test from "node:test";
import assert from "node:assert/strict";

import { authenticateAdmin } from "../src/admin/access.js";

function base64Url(value) {
  const bytes = value instanceof Uint8Array
    ? value
    : new TextEncoder().encode(JSON.stringify(value));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function signedToken(privateKey, payload, kid = "test-key") {
  const header = base64Url({ alg: "RS256", kid, typ: "JWT" });
  const body = base64Url(payload);
  const message = `${header}.${body}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    privateKey,
    new TextEncoder().encode(message)
  );
  return `${message}.${base64Url(new Uint8Array(signature))}`;
}

test("rejects missing and malformed Cloudflare Access assertions", async () => {
  const environment = {
    CF_ACCESS_TEAM_DOMAIN: "hydroponics",
    CF_ACCESS_AUD: "admin-audience"
  };
  assert.equal(await authenticateAdmin(new Request("https://worker.example/admin"), environment), null);
  assert.equal(await authenticateAdmin(new Request("https://worker.example/admin", {
    headers: { "Cf-Access-Jwt-Assertion": "not-a-jwt" }
  }), environment), null);
});

test("verifies an RS256 Access assertion and normalizes configured secrets", async (context) => {
  const keys = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256"
    },
    true,
    ["sign", "verify"]
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  const originalFetch = globalThis.fetch;
  context.after(() => { globalThis.fetch = originalFetch; });
  let certificateUrl = null;
  globalThis.fetch = async (url) => {
    certificateUrl = String(url);
    return Response.json({ keys: [publicJwk] });
  };

  const issuer = "https://hydroponics.cloudflareaccess.com";
  const token = await signedToken(keys.privateKey, {
    iss: `${issuer}/`,
    aud: ["admin-audience"],
    exp: Math.floor(Date.now() / 1000) + 300,
    nbf: Math.floor(Date.now() / 1000) - 30,
    email: "owner@example.com",
    sub: "access-user-1"
  });
  const request = new Request("https://worker.example/admin", {
    headers: { "Cf-Access-Jwt-Assertion": token }
  });
  const admin = await authenticateAdmin(request, {
    CF_ACCESS_TEAM_DOMAIN: "\uFEFF hydroponics ",
    CF_ACCESS_AUD: "\uFEFFadmin-audience\r\n"
  });

  assert.equal(certificateUrl, `${issuer}/cdn-cgi/access/certs`);
  assert.deepEqual(admin, {
    id: "owner@example.com",
    email: "owner@example.com",
    subject: "access-user-1"
  });
});
