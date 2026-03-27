import { describe, expect, test } from "vitest";

import {
  apiRequest,
  base64FromBytes,
  generateSigningKeyPair,
  jsonRequest,
  requestChallenge,
  signText,
  solvePow,
} from "./helpers";

describe("auth negative cases", () => {
  test("rejects invalid proof-of-work solution", async () => {
    const keyPair = await generateSigningKeyPair();
    const { challengeBody } = await requestChallenge(keyPair.publicKey);
    const signature = await signText(keyPair.privateKey, challengeBody.nonce);

    const { response, body } = await jsonRequest("/auth/register", {
      method: "POST",
      json: {
        public_key: keyPair.publicKey,
        nonce: challengeBody.nonce,
        solution: 0,
        signature,
        name: "bad-pow",
      },
    });

    expect(response.status).toBe(400);
    expect((body as any).error.code).toBe("pow_invalid");
  });

  test("rejects invalid registration signature", async () => {
    const keyPair = await generateSigningKeyPair();
    const { challengeBody } = await requestChallenge(keyPair.publicKey);
    const bogusSignature = base64FromBytes(new Uint8Array(64));
    const solution = solvePow(challengeBody.nonce, keyPair.publicKey, challengeBody.difficulty);

    const { response, body } = await jsonRequest("/auth/register", {
      method: "POST",
      json: {
        public_key: keyPair.publicKey,
        nonce: challengeBody.nonce,
        solution,
        signature: bogusSignature,
        name: "bad-signature",
      },
    });

    expect([400, 401]).toContain(response.status);
    expect(["pow_invalid", "signature_invalid"]).toContain((body as any).error.code);
  });

  test("rejects reused challenge nonce after successful registration", async () => {
    const keyPair = await generateSigningKeyPair();
    const { challengeBody } = await requestChallenge(keyPair.publicKey);
    const solution = solvePow(challengeBody.nonce, keyPair.publicKey, challengeBody.difficulty);
    const signature = await signText(keyPair.privateKey, challengeBody.nonce);

    const first = await jsonRequest("/auth/register", {
      method: "POST",
      json: {
        public_key: keyPair.publicKey,
        nonce: challengeBody.nonce,
        solution,
        signature,
        name: "first",
      },
    });
    expect(first.response.status).toBe(201);

    const second = await jsonRequest("/auth/register", {
      method: "POST",
      json: {
        public_key: keyPair.publicKey,
        nonce: challengeBody.nonce,
        solution,
        signature,
        name: "second",
      },
    });
    expect([409, 410]).toContain(second.response.status);
    expect(["already_exists", "pow_expired"]).toContain((second.body as any).error.code);
  });

  test("rejects malformed API key on protected routes", async () => {
    const { response, body } = await apiRequest("/auth/me", {
      headers: { authorization: "ApiKey definitely-not-valid" },
    });
    expect(response.status).toBe(401);
    expect((body as any).error.code).toBe("authentication_required");
  });
});
