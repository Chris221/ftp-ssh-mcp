// test/fixtures/host-key.mjs
// A throwaway RSA host key, generated per test run. Never a committed key.

import { createHash, generateKeyPairSync } from "node:crypto";
import { utils } from "ssh2";

export function generateHostKey() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  return privateKey;
}

/**
 * The SHA-256 fingerprint of a key, in the `SHA256:<base64>` rendering that
 * `ssh-keygen -lf` prints and SSH_HOST_FINGERPRINT accepts.
 *
 * Derived independently of src/: it parses the key and hashes the public SSH
 * blob via ssh2's own parser, so a test comparing against this value is
 * checking the server's fingerprint logic rather than restating it.
 */
export function fingerprintOf(privateKeyPem) {
  const publicBlob = utils.parseKey(privateKeyPem).getPublicSSH();
  const digest = createHash("sha256").update(publicBlob).digest("base64").replace(/=+$/, "");
  return `SHA256:${digest}`;
}
