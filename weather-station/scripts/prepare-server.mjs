// Local provisioning artifacts only. No network, no flashing, no credential output.
import { existsSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createPublicKey, randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";

const directory = realpathSync(process.argv[2] || "");
const repository = realpathSync(fileURLToPath(new URL("../../", import.meta.url)));
const rel = relative(repository, directory);
if (!rel.startsWith("..") && !isAbsolute(rel) || /(?:^|[\\/])(?:Dropbox|OneDrive)(?:[\\/]|$)/i.test(directory))
  throw new Error("Use a private directory outside Git and cloud-sync folders");
const writeOnce = (name, content) => {
  const path = resolve(directory, name);
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== content) throw new Error(`Existing ${name} differs; review instead of overwriting`);
  } else writeFileSync(path, content, { flag: "wx", mode: 0o600 });
};
const keyPath = resolve(directory, "ota-signing.pem");
if (!existsSync(keyPath)) execFileSync(process.execPath,
  [fileURLToPath(new URL("release.mjs", import.meta.url)), "keygen", keyPath], { stdio: "pipe" });
const publicKey = createPublicKey(readFileSync(keyPath)).export({ type: "spki", format: "pem" });
const credentialPath = resolve(directory, "device-credential.json");
const credential = existsSync(credentialPath) ? JSON.parse(readFileSync(credentialPath, "utf8")) : {
  device_id: "balcony-weather-01", credential_id: "balcony-weather-01-v1", token: randomBytes(32).toString("base64url")
};
if (credential.device_id !== "balcony-weather-01" || credential.credential_id !== "balcony-weather-01-v1" ||
    !/^[A-Za-z0-9_-]{43}$/.test(credential.token)) throw new Error("Unexpected local credential file");
writeOnce("device-credential.json", JSON.stringify(credential, null, 2) + "\n");
const hash = createHash("sha256").update(credential.token).digest("hex");
writeOnce("credential.sql", `INSERT INTO device_credentials (id,device_id,label,secret_sha256,created_at)
VALUES ('${credential.credential_id}','${credential.device_id}','Weather station initial credential','${hash}',strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(id) DO NOTHING;\n`);
writeOnce("worker-public-key.json", JSON.stringify({ STATION_OTA_PUBLIC_KEY: publicKey }, null, 2) + "\n");
writeOnce("device-config.h", `// Merge these two definitions into local secrets.h before the next USB commissioning build.\n#define STATION_DEVICE_TOKEN ${JSON.stringify(credential.token)}\n#define STATION_OTA_PUBLIC_KEY ${JSON.stringify(publicKey)}\n`);
console.log("Prepared/reused private signing key, device credential, hash-only SQL and public-key configuration. Nothing uploaded.");
console.log(`Public key SHA-256: ${createHash("sha256").update(publicKey).digest("hex")}`);
