import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import { findQuarryAddress, getPublicProvider } from "./helpers";
import {
  findEpochGaugeAddress,
  findEpochGaugeVoteAddress,
  findEpochGaugeVoterAddress,
  findGaugeAddress,
  findGaugeVoteAddress,
  findGaugeVoterAddress,
  GAUGE_CODERS,
  GaugeSDK,
} from "@quarryprotocol/gauge";
import { GAUGEMEISTER, REWARDER_KEY } from "./constants";
import { sendTransaction } from "./transaction";
import { findEscrowAddress } from "@tribecahq/tribeca-sdk";
import _ from "lodash";
import pLimit from "p-limit";
import { parsers } from "./parsers";
import fs from "fs";
import { saveDataToGitHub } from "./github";

const MIN_VEV = 50000;

const keypair = Keypair.fromSecretKey(
  Buffer.from(new Uint8Array(JSON.parse(process.env.BOT_PK!))),
);
console.log(keypair.publicKey.toString());

type VeVHolder = {
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
  veV: number;
};

const getVeVHolders = async () => {
  const response = await fetch(
    "https://raw.githubusercontent.com/saberdao/birdeye-data/refs/heads/main/veTokenHolders/VAULTVXqi93aaq9FsyPKgdgp6Ge1H1HoSvNC4ZbqFDs.json",
  );
  const data = await response.json();
  return data.map((holder) => {
    return {
      ...holder,
      veV: Math.max(
        0,
        ((Number(holder.data.amount) *
          (parseInt(holder.data.escrowEndsAt) -
            Math.round(Date.now() / 1000))) /
          (365 * 5 * 86400)) *
          10,
      ),
    };
  }) as VeVHolder[];
};

const getEligibleHolders = async () => {
  const holders = await getVeVHolders();
  return holders.filter(
    (holder: any) =>
      (holder.veV > MIN_VEV * 1e6 ||
        holder.data.owner === "EXdZNfWheWzNZrg53atXSaWqLNtMssdUzB6kNzHxn9Mf") &&
      holder.data.owner === holder.data.voteDelegate, // Exclude votex delegators
  );
};

const getGaugeKeys = async () => {
  const validatorTokenList = (await fetch(
    "https://raw.githubusercontent.com/SolanaVault/gauge-validator-sync-list-build/refs/heads/main/list.json",
  ).then((res) => res.json())) as Record<string, string>;

  const allStakedTokenMints = Object.values(validatorTokenList);
  const gaugeKeys = await Promise.all(
    allStakedTokenMints.map(async (stakedTokenMint) => {
      const [quarryKey] = findQuarryAddress(
        new PublicKey(REWARDER_KEY),
        new PublicKey(stakedTokenMint),
      );
      const [key] = await findGaugeAddress(
        new PublicKey(GAUGEMEISTER),
        quarryKey,
      );
      return key;
    }),
  );

  return { gaugeKeys };
};

const getCommitVoteIxs = async (
  connection: Connection,
  gaugeKeys: PublicKey[],
  voter: VeVHolder,
  epoch: number,
) => {
  if (!voter) {
    throw new Error("Test voter not found");
  }

  const provider = getPublicProvider(keypair.publicKey, connection);
  const gaugeSDK = GaugeSDK.load({ provider });

  // Prepare or reset epoch gauge voter
  const [escrowKey] = await findEscrowAddress(
    new PublicKey(voter.data.locker),
    new PublicKey(voter.data.owner),
  );
  const [gaugeVoter] = await findGaugeVoterAddress(
    new PublicKey(GAUGEMEISTER),
    new PublicKey(escrowKey),
  );
  const [epochGaugeVoterAddress] = await findEpochGaugeVoterAddress(
    gaugeVoter,
    epoch + 1,
  );
  const epochGaugeVoter = await connection.getAccountInfo(
    epochGaugeVoterAddress,
  );

  const ixs: TransactionInstruction[] = [];

  if (!epochGaugeVoter) {
    if (!(await connection.getAccountInfo(gaugeVoter))) {
      console.log("Gauge voter not found");
      return false;
    }
    ixs.push(
      ...(
        await gaugeSDK.gauge.prepareEpochGaugeVoter({
          gaugemeister: new PublicKey(GAUGEMEISTER),
          owner: new PublicKey(voter.data.owner),
          payer: keypair.publicKey,
        })
      ).instructions,
    );
  } else {
    if (
      GAUGE_CODERS.Gauge.accounts.epochGaugeVoter
        .parse(epochGaugeVoter.data)
        .allocatedPower.toNumber() !== 0
    ) {
      console.log("Already voted");
      return false;
    }
    ixs.push(
      ...(
        await gaugeSDK.gauge.resetEpochGaugeVoter({
          gaugemeister: new PublicKey(GAUGEMEISTER),
          owner: new PublicKey(voter.data.owner),
        })
      ).instructions,
    );
  }

  // Commit votes
  const gaugeVoteKeys = await Promise.all(
    gaugeKeys.map(async (gaugeKey) => {
      const [gaugeVoteKey] = await findGaugeVoteAddress(gaugeVoter, gaugeKey);
      return gaugeVoteKey;
    }),
  );
  const gaugeVotes = (
    await Promise.all(
      _.chunk(gaugeVoteKeys, 100).map(async (chunk) => {
        return await connection.getMultipleAccountsInfo(chunk);
      }),
    )
  ).flat();
  const parsedGaugeVotes = gaugeVotes.map((gv) =>
    gv && "data" in gv
      ? GAUGE_CODERS.Gauge.accounts.gaugeVote.parse(gv.data)
      : null,
  );

  const gaugesToCommit = gaugeKeys.filter((gk) => {
    const gaugeVote = parsedGaugeVotes.find((gv) => gv?.gauge.equals(gk));
    return gaugeVote && gaugeVote.weight !== 0;
  });

  // commit the votes
  const voteTXs = await Promise.all(
    gaugesToCommit.map(async (gaugeKey) => {
      const [gaugeVote] = await findGaugeVoteAddress(gaugeVoter, gaugeKey);
      const [epochGaugeVoter] = await findEpochGaugeVoterAddress(
        gaugeVoter,
        epoch + 1,
      );
      const [epochGauge, epochGaugeBump] = await findEpochGaugeAddress(
        gaugeKey,
        epoch + 1,
      );
      const [epochGaugeVote] = await findEpochGaugeVoteAddress(
        gaugeVote,
        epoch + 1,
      );

      const iixs: TransactionInstruction[] = [];

      if (!(await gaugeSDK.gauge.fetchEpochGauge(epochGauge))) {
        iixs.push(
          gaugeSDK.gauge.program.instruction.createEpochGauge(
            epochGaugeBump,
            epoch + 1,
            {
              accounts: {
                epochGauge,
                gauge: gaugeKey,
                payer: keypair.publicKey,
                systemProgram: SystemProgram.programId,
              },
            },
          ),
        );
      }

      iixs.push(
        gaugeSDK.gauge.program.instruction.gaugeCommitVoteV2({
          accounts: {
            gaugemeister: new PublicKey(GAUGEMEISTER),
            gauge: gaugeKey,
            gaugeVoter,
            gaugeVote,
            payer: keypair.publicKey,
            systemProgram: SystemProgram.programId,
            epochGauge,
            epochGaugeVoter,
            epochGaugeVote,
          },
        }),
      );
      return iixs;
    }),
  );
  ixs.push(...voteTXs.flat());

  return ixs;
};

const run = async () => {
  const connection = new Connection(process.env.RPC_URL!);

  // @TODO: Get current epoch and do not run if already ran
  const gaugemeister = await connection.getAccountInfo(
    new PublicKey(GAUGEMEISTER),
  );
  if (!gaugemeister) {
    console.log("no gaugemeister");
    return;
  }
  const gm = parsers.gaugemeister(gaugemeister.data);
  const currentEpoch = gm.currentRewardsEpoch;

  const lastParsedEpoch = Number(fs.readFileSync("last_parsed_epoch", "utf8"));
  console.log(`Current epoch: ${currentEpoch}`);
  console.log(`Last parsed epoch: ${lastParsedEpoch}`);
  if (currentEpoch <= lastParsedEpoch) {
    console.log("Already parsed");
    process.exit(0);
  }

  const eligibleHolders = await getEligibleHolders();
  console.log(`Amount of eligible holders: ${eligibleHolders.length}`);
  const { gaugeKeys } = await getGaugeKeys();

  const limit = pLimit(1);
  await limit.map([eligibleHolders[8]], async (eligibleHolder, i) => {
    console.log(`Processing holder: ${eligibleHolder.data.owner}`);
    const ixs = await getCommitVoteIxs(
      connection,
      gaugeKeys,
      eligibleHolder,
      currentEpoch,
    );

    if (ixs) {
      const hash = await sendTransaction(connection, ixs, [], keypair);
      console.log(hash);
    }
    console.log(`Processed ${i + 1} of ${eligibleHolders.length} holders`);
    console.log(`--------------------------------`);
  });

  await saveDataToGitHub([
    {
      path: "last_parsed_epoch",
      content: currentEpoch.toString(),
    },
  ]);
  console.log("Data saved to GitHub");
};

run();
