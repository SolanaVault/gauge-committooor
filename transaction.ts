import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Connection,
  LAMPORTS_PER_SOL,
  PublicKey,
  Signer,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { retryTransaction } from "./retry";

const getComputeUnitsForTx = async (
  connection: Connection,
  latestBlockhash: Awaited<ReturnType<typeof connection.getLatestBlockhash>>,
  txs: TransactionInstruction[],
  payerKey: PublicKey,
  retryNum = 0,
): Promise<number> => {
  const messageV0 = new TransactionMessage({
    payerKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions: txs,
  }).compileToV0Message();
  const transaction = new VersionedTransaction(messageV0);
  const simulation = await connection.simulateTransaction(transaction);
  if (simulation.value.unitsConsumed === 0) {
    if (retryNum >= 900) {
      return 1.4e6;
    }
    console.log("CU zero, retrying...", retryNum);
    console.log("Full simulation response:", simulation);
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return getComputeUnitsForTx(
      connection,
      latestBlockhash,
      txs,
      payerKey,
      retryNum + 1,
    );
  }
  const CUs = simulation.value.unitsConsumed ?? 1.4e6;
  return CUs;
};

export const createVersionedTransaction = async (
  connection: Connection,
  txs: TransactionInstruction[],
  payerKey: PublicKey,
  luts?: AddressLookupTableAccount[],
) => {
  const latestBlockhash = await connection.getLatestBlockhash("finalized");
  const cUBudget = 400000; // +1000 for safety and the CU limit ix itself

  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({
      units: cUBudget,
    }),
  ];

  const priorityFee = 0.0001 * LAMPORTS_PER_SOL * 1e6;
  instructions.unshift(
    ComputeBudgetProgram.setComputeUnitPrice({
      microLamports: Math.ceil(priorityFee / cUBudget),
    }),
  );
  instructions.push(...txs);

  const messageV0 = new TransactionMessage({
    payerKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions,
  }).compileToV0Message(luts);
  const transaction = new VersionedTransaction(messageV0);
  return { transaction, latestBlockhash };
};

export const sendTransaction = async (
  connection: Connection,
  txs: TransactionInstruction[],
  allSigners: Signer[],
  payerKey: Signer,
  luts?: AddressLookupTableAccount[],
): Promise<{ hash: string }> => {
  const stakedRpc = process.env.RPC_URL;
  if (!stakedRpc) {
    throw Error("No staked RPC URL found");
  }
  const stakedConnection = new Connection(stakedRpc);
  try {
    const hash = await retryTransaction(
      async () => {
        const vt = await createVersionedTransaction(
          connection,
          txs,
          payerKey.publicKey,
          luts,
        );
        // Filter only the required signers
        const signerPubkeys = vt.transaction.message.staticAccountKeys
          .slice(0, vt.transaction.message.header.numRequiredSignatures)
          .map((p) => p.toString());

        const signers = allSigners.filter((s) =>
          signerPubkeys.includes(s.publicKey.toString()),
        );
        vt.transaction.sign([payerKey, ...signers]);

        console.log(Buffer.from(vt.transaction.serialize()).toString("base64"));

        let timeoutId: ReturnType<typeof setTimeout>;
        const timeout = new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error("Timeout")), 120_000);
        });
        try {
          return await Promise.race([
            (async () => {
              const hash = await stakedConnection.sendTransaction(
                vt.transaction,
                { skipPreflight: true },
              );
              await connection.confirmTransaction(
                {
                  signature: hash,
                  ...vt.latestBlockhash,
                },
                "processed",
              );
              return hash;
            })(),
            timeout,
          ]);
        } finally {
          clearTimeout(timeoutId!);
        }
      },
      {
        onRetry: (error, nextAttempt, delayMs) => {
          console.log(
            `Retryable transaction error; attempt ${nextAttempt} starts in ${delayMs}ms`,
            error,
          );
        },
      },
    );
    console.log("Succeeded", hash);
    return { hash };
  } catch (e: unknown) {
    console.log("Error", e);
    throw e;
  }
};
