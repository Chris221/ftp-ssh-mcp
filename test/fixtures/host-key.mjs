// test/fixtures/host-key.mjs
// A throwaway RSA host key, generated per test run. Never a committed key.

import { generateKeyPairSync } from "node:crypto";

export function generateHostKey() {
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "pkcs1", format: "pem" },
  });
  return privateKey;
}
