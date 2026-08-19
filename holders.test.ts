import assert from "node:assert/strict";
import test from "node:test";
import { Keypair, PublicKey } from "@solana/web3.js";
import { findEscrowAddress } from "@tribecahq/tribeca-sdk";
import {
  EXPECTED_LOCKER,
  MAX_HOLDERS,
  parseOnChainHolders,
  selectEligibleHolders,
} from "./holders";

const OWNER = new PublicKey("11111111111111111111111111111111");
const OTHER_OWNER = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const TOKENS = new PublicKey(
  "So11111111111111111111111111111111111111112",
);
const NOW = 1_000;

const number = (value: string | number) => ({ toString: () => String(value) });

const escrowFixture = async (
  overrides: Record<string, unknown> = {},
) => {
  const locker = (overrides.locker as PublicKey | undefined) ??
    new PublicKey(EXPECTED_LOCKER);
  const owner = (overrides.owner as PublicKey | undefined) ?? OWNER;
  const [publicKey, bump] = await findEscrowAddress(locker, owner);
  return {
    publicKey,
    account: {
      locker,
      owner,
      bump,
      tokens: TOKENS,
      amount: number("1000000000000"),
      escrowStartedAt: number(NOW),
      escrowEndsAt: number(NOW + 5 * 365 * 86400),
      voteDelegate: owner,
      ...overrides,
    },
  };
};

test("derives eligible holders from decoded on-chain escrows", async () => {
  const holders = await parseOnChainHolders(
    [
      await escrowFixture(),
      await escrowFixture({ owner: OTHER_OWNER, voteDelegate: OWNER }),
    ],
    NOW,
  );

  assert.equal(holders.length, 2);
  assert.deepEqual(
    selectEligibleHolders(holders).map((holder) => holder.data.owner),
    [OWNER.toBase58()],
  );
  assert.equal(holders[0].veV, 10_000_000_000_000n);
});

test("rejects escrows outside the expected locker or PDA", async () => {
  await assert.rejects(
    parseOnChainHolders(
      [await escrowFixture({ locker: OTHER_OWNER })],
      NOW,
    ),
    /expected locker/,
  );

  const wrongAddress = await escrowFixture();
  wrongAddress.publicKey = Keypair.generate().publicKey;
  await assert.rejects(
    parseOnChainHolders([wrongAddress], NOW),
    /expected escrow PDA/,
  );
});

test("rejects invalid on-chain numeric data", async () => {
  const invalidFields: Record<string, unknown>[] = [
    { bump: 256 },
    { amount: number(-1) },
    { escrowStartedAt: number(-1) },
    { escrowEndsAt: number(NOW + 5 * 365 * 86400 + 1) },
  ];

  for (const invalidField of invalidFields) {
    await assert.rejects(
      parseOnChainHolders([await escrowFixture(invalidField)], NOW),
    );
  }
});

test("bounds account count and deduplicates only identical holders", async () => {
  const escrow = await escrowFixture();
  await assert.rejects(
    parseOnChainHolders(Array(MAX_HOLDERS + 1).fill(escrow), NOW),
    /record limit/,
  );
  assert.equal(
    (await parseOnChainHolders([escrow, escrow], NOW)).length,
    1,
  );
  await assert.rejects(
    parseOnChainHolders(
      [
        escrow,
        {
          ...escrow,
          account: { ...escrow.account, amount: number("999999999999") },
        },
      ],
      NOW,
    ),
    /Conflicting duplicate holder/,
  );
});
