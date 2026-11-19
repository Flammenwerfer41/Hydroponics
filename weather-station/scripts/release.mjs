import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { HARDWARE, MAX_FIRMWARE_BYTES, VERSION_PATTERN, manifestMessage } from "../../cloudflare-worker/src/station/contract.js";

export function makeManifest(binary, version, privatePem) {
  if (binary.includes(Buffer.from("compile-check-not-a-real-token-0000")))
    throw new Error("Compile-check firmware is not deployable; build with real station settings first");
  if (!VERSION_PATTERN.test(version) || binary.length < 512 || binary.length > MAX_FIRMWARE_BYTES)
    throw new Error("Invalid version or image size");
  // ESP image header (24) + first segment header (8) + app descriptor.
  if (binary[0] !== 0xe9 || binary.readUInt16LE(12) !== 13 || binary.readUInt32LE(32) !== 0xabcd5432)
    throw new Error("Not an ESP32-C6 application image");
  const descriptorVersion = binary.subarray(48, 80).toString().split("\0")[0];
  const project = binary.subarray(80, 112).toString().split("\0")[0];
  if (project !== "balcony-weather" || descriptorVersion !== version)
    throw new Error("Image project/version does not match the requested release");
  const key = createPrivateKey(privatePem);
  if (key.asymmetricKeyType !== "rsa" || key.asymmetricKeyDetails.modulusLength !== 2048)
    throw new Error("RSA-2048 signing key required");
  const manifest = { hardware: HARDWARE, version, size: binary.length,
    sha256: createHash("sha256").update(binary).digest("hex") };
  manifest.signature = sign("sha256", Buffer.from(manifestMessage(manifest)), key).toString("base64");
  return manifest;
}

export function checkConfiguration(source, privatePem) {
  const value = name => {
    const match = source.match(new RegExp(`^\\s*#define\\s+${name}\\s+(\"(?:[^\"\\\\]|\\\\.)*\")\\s*$`, "m"));
    return match ? JSON.parse(match[1]) : "";
  };
  if (!value("STATION_WIFI_SSID") || !/^https:\/\/[^/]+$/.test(value("STATION_SERVER")) ||
      !/^[A-Za-z0-9._~-]{24,256}$/.test(value("STATION_DEVICE_TOKEN"))) throw new Error("Wi-Fi/server/device configuration missing");
  const expected = createPublicKey(privatePem).export({ type: "spki", format: "pem" });
  const actual = createPublicKey(value("STATION_OTA_PUBLIC_KEY")).export({ type: "spki", format: "pem" });
  if (expected !== actual) throw new Error("Signing key differs from device trust key; review key rotation separately");
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === "keygen" && args.length === 1) {
      const pair = generateKeyPairSync("rsa", { modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs8", format: "pem" } });
      writeFileSync(args[0], pair.privateKey, { flag: "wx", mode: 0o600 });
      writeFileSync(`${args[0]}.public.pem`, pair.publicKey, { flag: "wx" });
      console.log("Key generated. Keep private key offline, outside Dropbox and Git.");
    } else if (command === "public-header" && args.length === 1) {
      const pem = createPublicKey(readFileSync(args[0])).export({ type: "spki", format: "pem" });
      console.log(`#define STATION_OTA_PUBLIC_KEY ${JSON.stringify(pem)}`);
    } else if (command === "check-config" && args.length === 2) {
      checkConfiguration(readFileSync(args[0], "utf8"), readFileSync(args[1]));
      console.log("Release configuration ready (credentials not displayed).");
    } else if (command === "sign" && args.length === 4) {
      const [image, version, key, output] = args;
      const manifest = makeManifest(readFileSync(image), version, readFileSync(key));
      writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
      console.log(`R2 object key: firmware/${manifest.sha256}.bin`);
    } else throw new Error("Usage: release.mjs keygen KEY | public-header PUBLIC_KEY | check-config SECRETS PRIVATE_KEY | sign IMAGE VERSION PRIVATE_KEY MANIFEST");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
