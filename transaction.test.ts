import assert from "node:assert/strict";
import test from "node:test";
import {
  Connection,
  Keypair,
  SystemProgram,
} from "@solana/web3.js";
import { createVersionedTransaction } from "./transaction";

test("transaction construction does not mutate instructions across retries", async () => {
  const payer = Keypair.generate().publicKey;
  const instruction = SystemProgram.transfer({
    fromPubkey: payer,
    toPubkey: Keypair.generate().publicKey,
    lamports: 1,
  });
  const instructions = [instruction];
  const connection = {
    getLatestBlockhash: async () => ({
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 1,
    }),
  } as unknown as Connection;

  await createVersionedTransaction(connection, instructions, payer);
  await createVersionedTransaction(connection, instructions, payer);

  assert.equal(instructions.length, 1);
  assert.equal(instructions[0], instruction);
});
