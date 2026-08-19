import assert from "node:assert/strict";
import test from "node:test";
import {
  isRetryableTransactionError,
  retryTransaction,
} from "./retry";

test("classifies only transient transaction failures as retryable", () => {
  assert.equal(isRetryableTransactionError(new Error("Timeout")), true);
  assert.equal(
    isRetryableTransactionError(new Error("BLOCKHASH NOT FOUND")),
    true,
  );
  assert.equal(
    isRetryableTransactionError(new Error("block height exceeded")),
    true,
  );
  assert.equal(isRetryableTransactionError(new Error("insufficient funds")), false);
});

test("returns immediately after a successful attempt", async () => {
  let attempts = 0;
  const result = await retryTransaction(async () => {
    attempts += 1;
    return "ok";
  });

  assert.equal(result, "ok");
  assert.equal(attempts, 1);
});

test("uses finite exponential backoff for transient failures", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const result = await retryTransaction(
    async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("Timeout");
      return "ok";
    },
    { sleep: async (delay) => void delays.push(delay) },
  );

  assert.equal(result, "ok");
  assert.equal(attempts, 3);
  assert.deepEqual(delays, [5_000, 10_000]);
});

test("stops after three transient failures", async () => {
  let attempts = 0;
  await assert.rejects(
    retryTransaction(
      async () => {
        attempts += 1;
        throw new Error("Blockhash not found");
      },
      { sleep: async () => undefined },
    ),
    /Blockhash not found/,
  );
  assert.equal(attempts, 3);
});

test("does not retry permanent failures", async () => {
  let attempts = 0;
  await assert.rejects(
    retryTransaction(async () => {
      attempts += 1;
      throw new Error("insufficient funds");
    }),
    /insufficient funds/,
  );
  assert.equal(attempts, 1);
});
