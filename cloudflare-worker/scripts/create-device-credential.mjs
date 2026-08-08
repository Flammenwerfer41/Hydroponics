import { createHash, randomBytes } from "node:crypto";

const credential = randomBytes(32).toString("base64url");
const digest = createHash("sha256").update(credential, "utf8").digest("hex");

console.log("Device credential (store only in secrets.h):");
console.log(credential);
console.log("\nSHA-256 digest (store in D1):");
console.log(digest);
console.log("\nThis command does not write either value to disk.");

