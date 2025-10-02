import { utils } from "@coral-xyz/anchor";
import { GAUGE_ADDRESSES } from "@quarryprotocol/gauge";
import { QUARRY_ADDRESSES } from "@quarryprotocol/quarry-sdk";
import { SolanaProvider } from "@saberhq/solana-contrib";
import {
  PublicKey,
  Connection,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";

export const getPublicProvider = (
  wallet: PublicKey,
  connection: Connection,
) => {
  const anchorWallet = {
    publicKey: wallet,
    // eslint-disable-next-line @typescript-eslint/require-await
    signTransaction: async <T extends Transaction | VersionedTransaction>(
      tx: T,
    ) => {
      return tx;
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(
      txs: T[],
    ) => {
      return txs;
    },
  };

  const provider = SolanaProvider.init({
    connection,
    wallet: anchorWallet,
  });
  return provider;
};

const encodeU32 = (num: number): Buffer => {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(num);
  return buf;
};

export const findEpochGaugeAddress = (
  gauge: PublicKey,
  votingEpoch: number,
): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync(
    [
      utils.bytes.utf8.encode("EpochGauge"),
      gauge.toBuffer(),
      encodeU32(votingEpoch),
    ],
    GAUGE_ADDRESSES.Gauge,
  );
};

export const findQuarryAddress = (
  rewarder: PublicKey,
  tokenMint: PublicKey,
  programID: PublicKey = QUARRY_ADDRESSES.Mine,
): [PublicKey, number] => {
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from(utils.bytes.utf8.encode("Quarry")),
      rewarder.toBytes(),
      tokenMint.toBytes(),
    ],
    programID,
  );
};
