import { validateManifest, verifyManifest } from "./contract.js";

// Small, bounded C6 application images only. The device performs the full ESP image check.
export async function verifyImage(bytes, manifest) {
  const data = new Uint8Array(bytes);
  if (data.byteLength !== manifest.size || data.byteLength < 512) throw new Error("Image size mismatch");
  const header = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const text = (from, to) => new TextDecoder().decode(data.subarray(from, to)).split("\0")[0];
  if (data[0] !== 0xe9 || header.getUint16(12, true) !== 13 || header.getUint32(32, true) !== 0xabcd5432 ||
      text(48, 80) !== manifest.version || text(80, 112) !== "balcony-weather")
    throw new Error("Wrong image hardware, project or version");
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, "0")).join("");
  if (hash !== manifest.sha256) throw new Error("Image checksum mismatch");
}

export async function verifyStoredImage(bucket, manifest) {
  const object = await bucket?.get(`firmware/${manifest.sha256}.bin`);
  if (!object || object.size !== manifest.size) throw new Error("Firmware object unavailable");
  await verifyImage(await object.arrayBuffer(), manifest);
}

export async function readLimited(request, maximum) {
  if (Number(request.headers.get("Content-Length")) > maximum) throw new Error("Body too large");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Body required");
  let length = 0; const chunks = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    length += value.length;
    if (length > maximum) { await reader.cancel(); throw new Error("Body too large"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export async function uploadFirmware(request, bucket, pem) {
  if (!bucket) throw new Error("Firmware storage not configured");
  if (request.headers.get("Content-Type") !== "application/octet-stream") throw new Error("Expected binary image");
  const header = request.headers.get("X-Station-Manifest");
  if (!header || header.length > 4096) throw new Error("Manifest header required");
  const manifest = validateManifest(JSON.parse(header));
  if (!await verifyManifest(manifest, pem)) throw new Error("Untrusted firmware signature");
  const bytes = await readLimited(request, manifest.size);
  await verifyImage(bytes, manifest);
  // Content-addressed, create-only: do not overwrite an existing release, even by mistake.
  await bucket.put(`firmware/${manifest.sha256}.bin`, bytes, {
    onlyIf: new Headers({ "If-None-Match": "*" }),
    httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" }
  });
  // Also verifies a previously uploaded object on an idempotent retry.
  await verifyStoredImage(bucket, manifest);
  return manifest;
}
