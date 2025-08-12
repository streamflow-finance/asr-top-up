import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Connection, Keypair, PublicKey, TransactionInstruction } from '@solana/web3.js';
import {
  prepareBaseInstructions,
  prepareTransaction,
  signAndExecuteTransaction,
  signTransaction,
  ThrottleParams,
} from '@streamflow/common/solana';
import BN from 'bn.js';
import PQueue from 'p-queue';
import { createRewardPoolDynamicClient } from './client.js';
import { STREAMFLOW_TREASURY } from './constants.js';
import type { BatchTransferItem } from './types.js';

/**
 * Transfers a certain amount to the reward pool:
 * - uses `execute or die` submission where we pretty much spam the blockchain with
 * txs to increase chance of tx landing, because we that we also use SEND_THROTTLER to throttle tx submissions,
 * as it's an expensive operation
 * @param {Connection} connection - Solana Connection
 * @param {Keypair} keypair - Transaction Signer and Fee Payer
 * @param {PublicKey} pubKey - pubkey of the Token Account
 * @param {string} mint - mint address
 * @param {PublicKey} programId - Program ID of the Mint
 * @param {PublicKey} recipient - reward pool Account address
 * @param {BN} amount - amount to transfer
 * @param {string | undefined | null} feeValue - fee value to set for the transaction
 * @param {number | undefined} computePrice - Compute Price to set for the transaction
 * @param {number | undefined} computeLimit - Compute Limit in CUs to set for the transaction
 * @param {PQueue | undefined} throttler - Throttler of send transactions
 * @param {boolean | undefined} isDryRun - Whether to dry run the transaction
 * @param {Console | undefined} logger - Logger to use
 * @returns {Promise<string | undefined>} Transaction signature (if not dry run)
 */
export async function transferTokensToRewardPool(
  connection: Connection,
  keypair: Keypair,
  pubKey: PublicKey,
  mint: string,
  programId: PublicKey,
  recipient: PublicKey,
  amount: BN,
  feeValue?: string | undefined | null,
  computePrice?: number,
  computeLimit?: number,
  throttler?: PQueue,
  isDryRun?: boolean,
  logger?: Console,
): Promise<string | undefined> {
  logger = logger ?? console;

  const program = createRewardPoolDynamicClient();

  const preInstructions = await getFundPoolPreInstructions(connection, pubKey, mint, programId);

  const fundPoolIx = await program.methods
    .fundPool(new BN(amount.toString()))
    .accounts({
      funder: pubKey,
      from: getAssociatedTokenAddressSync(new PublicKey(mint), pubKey, true, programId),
      rewardPool: recipient,
      tokenProgram: programId,
    })
    .accountsPartial({
      feeValue: feeValue ?? null,
    })
    .instruction();

  console.log('fundPoolIx: ', fundPoolIx);

  let ixs: TransactionInstruction[] = [
    ...prepareBaseInstructions(connection, {
      computePrice,
      computeLimit,
    }),
    ...preInstructions,
    fundPoolIx,
  ];

  const commitment = 'finalized';
  const { tx, hash, context } = await prepareTransaction(connection, ixs, pubKey, commitment);

  if (isDryRun) {
    logger.log(
      `Transfer to pool ${recipient.toString()} ${amount.toString()}. Execute fund pool `,
      Buffer.from(tx.serialize()).toString('base64'),
    );
    return;
  }

  while (true) {
    try {
      const res = await signAndExecuteTransaction(
        connection,
        keypair,
        tx,
        {
          hash,
          context,
          commitment,
        },
        { sendThrottler: throttler } as ThrottleParams,
      );
      logger.log(`Transferred ${amount.toString()} of ${mint.toString()} to ${recipient.toString()}: ${res}`);
      return res;
    } catch (err) {
      if (err instanceof Error && err.toString().includes('expired')) {
        continue;
      }
      logger.warn(`Transfer to ${recipient} failed: ${err}`);
      break;
    }
  }
}

/**
 * Batch transfers tokens to multiple reward pools in a single transaction
 * - Creates multiple fund pool instructions in one transaction
 * - Uses same retry logic as single transfers
 * @param {Connection} connection - Solana Connection
 * @param {Keypair} keypair - Transaction Signer and Fee Payer
 * @param {PublicKey} pubKey - pubkey of the Token Account
 * @param {BatchTransferItem[]} transfers - Array of transfer details (mint, recipient, amount)
 * @param {number | undefined} computePrice - Compute Price to set for the transaction
 * @param {number | undefined} computeLimit - Compute Limit in CUs to set for the transaction
 * @param {PQueue | undefined} throttler - Throttler of send transactions
 * @param {boolean | undefined} isDryRun - Whether to dry run the transaction
 * @param {Console | undefined} logger - Logger to use
 * @returns {Promise<string | undefined>} Transaction signature (if not dry run)
 */
export async function batchTransferTokensToRewardPools(
  connection: Connection,
  keypair: Keypair,
  pubKey: PublicKey,
  transfers: BatchTransferItem[],
  computePrice?: number,
  computeLimit?: number,
  throttler?: PQueue,
  isDryRun?: boolean,
  logger?: Console,
): Promise<string | undefined> {
  logger = logger ?? console;

  const x = await prepareBatchTransaction(connection, keypair, pubKey, transfers, computePrice, computeLimit, logger);

  if (!x) {
    logger.warn('Failed to prepare batch transaction');
    return;
  }

  const { tx, hash, context } = x;

  if (isDryRun) {
    const transferSummary = transfers
      .map((t) => `${t.amount.toString()} to ${t.recipient.toString()} (${t.mint.toString()})`)
      .join(', ');

    logger.log(
      `Batch transfer: ${transfers.length} pools - ${transferSummary}`,
      `Transaction: ${Buffer.from(tx.serialize()).toString('base64')}`,
    );
    return;
  }

  // Execute single transaction with retry logic
  while (true) {
    try {
      const res = await signAndExecuteTransaction(
        connection,
        keypair,
        tx,
        {
          hash,
          context,
          commitment: 'finalized',
        },
        { sendThrottler: throttler } as ThrottleParams,
      );

      const transferSummary = transfers
        .map((t) => `${t.amount.toString()} of ${t.mint.toString()} to ${t.recipient.toString()}`)
        .join(', ');

      logger.log(`Batch transfer completed - ${transferSummary}`);

      return res;
    } catch (err) {
      if (err instanceof Error && err.toString().includes('expired')) {
        continue;
      }

      logger.warn(`Batch transfer failed: ${err}`);
      break;
    }
  }
}

export async function prepareBatchTransaction(
  connection: Connection,
  keypair: Keypair,
  pubKey: PublicKey,
  transfers: BatchTransferItem[],
  computePrice?: number,
  computeLimit?: number,
  logger?: typeof console,
) {
  logger = logger ?? console;

  if (transfers.length === 0) {
    logger.warn('No transfers provided for batch operation');
    return;
  }

  const program = createRewardPoolDynamicClient();

  // Create all fund pool instructions
  const fundPoolInstructions: TransactionInstruction[] = [];

  const preInstructionsArray: TransactionInstruction[][] = [];

  for (const transfer of transfers) {
    const programId = transfer.isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

    const preInstructions = await getFundPoolPreInstructions(connection, pubKey, transfer.mint, programId);
    preInstructionsArray.push(preInstructions);

    const fundPoolIx = await program.methods
      .fundPool(new BN(transfer.amount.toString()))
      .accounts({
        funder: pubKey,
        from: getAssociatedTokenAddressSync(new PublicKey(transfer.mint), pubKey, undefined, programId),
        rewardPool: transfer.recipient,
        tokenProgram: programId,
      })
      .accountsPartial({
        feeValue: transfer.feeValue ?? null,
      })
      .instruction();

    fundPoolInstructions.push(fundPoolIx);
  }

  // Create single transaction with all instructions
  const ixs: TransactionInstruction[] = [
    ...prepareBaseInstructions(connection, {
      computePrice,
      computeLimit,
    }),
    ...preInstructionsArray.flat(),
    ...fundPoolInstructions,
  ];

  const commitment = 'finalized';
  const { tx, hash, context } = await prepareTransaction(connection, ixs, pubKey, commitment);

  signTransaction(keypair, tx);

  return {
    tx,
    hash,
    context,
  };
}

async function getFundPoolPreInstructions(
  connection: Connection,
  pubKey: PublicKey,
  mint: string,
  programId: PublicKey,
): Promise<TransactionInstruction[]> {
  const preInstructions: TransactionInstruction[] = [];

  const rewardMintAccountKey = getAssociatedTokenAddressSync(new PublicKey(mint), pubKey, true, programId);

  if (!(await connection.getAccountInfo(rewardMintAccountKey))) {
    preInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        pubKey,
        rewardMintAccountKey,
        pubKey,
        new PublicKey(mint),
        programId,
      ),
    );
  }

  const treasuryRewardAccountKey = getAssociatedTokenAddressSync(
    new PublicKey(mint),
    new PublicKey(STREAMFLOW_TREASURY),
    true,
    programId,
  );

  if (!(await connection.getAccountInfo(treasuryRewardAccountKey))) {
    preInstructions.push(
      createAssociatedTokenAccountIdempotentInstruction(
        pubKey,
        treasuryRewardAccountKey,
        new PublicKey(STREAMFLOW_TREASURY),
        new PublicKey(mint),
        programId,
      ),
    );
  }

  return preInstructions;
}
