import { PublicKey, type Connection } from "@solana/web3.js";
import {
  findEscrowAddress,
  TribecaSDK,
} from "@tribecahq/tribeca-sdk";
import { getPublicProvider } from "./helpers";

export const EXPECTED_LOCKER =
  "FqEk173TNsqe2maPozsaZk4AvaqpV3FKynyA5s7V4aNq";
export const MAX_HOLDERS = 5000;

const MAX_LOCK_DURATION_SECONDS = 5n * 365n * 86400n;
const MIN_VEV_BASE_UNITS = 50000n * 1_000_000n;

export type VeVHolder = {
  data: {
    locker: string;
    owner: string;
    bump: number;
    tokens: string;
    amount: string;
    escrowStartedAt: string;
    escrowEndsAt: string;
    voteDelegate: string;
  };
  veV: bigint;
};

type OnChainEscrowAccount = {
  publicKey: PublicKey;
  account: {
    locker: PublicKey;
    owner: PublicKey;
    bump: number;
    tokens: PublicKey;
    amount: { toString(): string };
    escrowStartedAt: { toString(): string };
    escrowEndsAt: { toString(): string };
    voteDelegate: PublicKey;
  };
};

const toHolder = async (
  { publicKey, account }: OnChainEscrowAccount,
  index: number,
  now: bigint,
): Promise<VeVHolder> => {
  const locker = account.locker.toBase58();
  if (locker !== EXPECTED_LOCKER) {
    throw new Error(`escrows[${index}] is not owned by the expected locker`);
  }
  if (
    !Number.isInteger(account.bump) ||
    account.bump < 0 ||
    account.bump > 255
  ) {
    throw new Error(`escrows[${index}] has an invalid bump`);
  }

  const [expectedAddress, expectedBump] = await findEscrowAddress(
    account.locker,
    account.owner,
  );
  if (!publicKey.equals(expectedAddress) || account.bump !== expectedBump) {
    throw new Error(`escrows[${index}] is not the expected escrow PDA`);
  }

  const amount = BigInt(account.amount.toString());
  const startedAt = BigInt(account.escrowStartedAt.toString());
  const endsAt = BigInt(account.escrowEndsAt.toString());
  if (
    amount < 0n ||
    startedAt < 0n ||
    endsAt < startedAt ||
    endsAt - startedAt > MAX_LOCK_DURATION_SECONDS
  ) {
    throw new Error(`escrows[${index}] has invalid numeric data`);
  }

  const remainingSeconds = endsAt > now ? endsAt - now : 0n;
  const veV =
    (amount * remainingSeconds * 10n) / MAX_LOCK_DURATION_SECONDS;

  return {
    data: {
      locker,
      owner: account.owner.toBase58(),
      bump: account.bump,
      tokens: account.tokens.toBase58(),
      amount: amount.toString(),
      escrowStartedAt: startedAt.toString(),
      escrowEndsAt: endsAt.toString(),
      voteDelegate: account.voteDelegate.toBase58(),
    },
    veV,
  };
};

export const parseOnChainHolders = async (
  accounts: OnChainEscrowAccount[],
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<VeVHolder[]> => {
  if (accounts.length > MAX_HOLDERS) {
    throw new Error(`On-chain holder data exceeds the ${MAX_HOLDERS}-record limit`);
  }
  if (!Number.isSafeInteger(nowSeconds) || nowSeconds < 0) {
    throw new Error("Current timestamp must be a non-negative safe integer");
  }

  const holdersByOwner = new Map<string, VeVHolder>();
  for (const [index, account] of accounts.entries()) {
    const holder = await toHolder(account, index, BigInt(nowSeconds));
    const previous = holdersByOwner.get(holder.data.owner);
    if (!previous) {
      holdersByOwner.set(holder.data.owner, holder);
      continue;
    }
    if (JSON.stringify(previous.data) !== JSON.stringify(holder.data)) {
      throw new Error(`Conflicting duplicate holder ${holder.data.owner}`);
    }
  }
  return [...holdersByOwner.values()];
};

export const selectEligibleHolders = (holders: VeVHolder[]): VeVHolder[] =>
  holders.filter(
    (holder) =>
      holder.veV > MIN_VEV_BASE_UNITS &&
      holder.data.owner === holder.data.voteDelegate,
  );

export const getEligibleHolders = async (
  connection: Connection,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<VeVHolder[]> => {
  const provider = getPublicProvider(new PublicKey(EXPECTED_LOCKER), connection);
  const tribecaSDK = TribecaSDK.load({ provider });
  const accounts = await tribecaSDK.programs.LockedVoter.account.escrow.all([
    { memcmp: { offset: 8, bytes: EXPECTED_LOCKER } },
  ]);
  return selectEligibleHolders(
    await parseOnChainHolders(accounts, nowSeconds),
  );
};
