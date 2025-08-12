import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { Connection, PublicKey } from '@solana/web3.js';
import { invariant } from '@streamflow/common';
import BN from 'bn.js';
import { createWriteStream } from 'fs';
import { calculateTokensNeededForTargetAPY } from './lib/apy-token-based.js';
import { COMPUTE_PRICE, DEFAULT_CU, SEND_THROTTLER } from './lib/constants.js';
import { parseKeypairSync } from './lib/keypair.js';
import { createLogger } from './lib/logger.js';
import { notify } from './lib/notify.js';
import { estimateCompleteTransactionCost, fetchFunderBalances, fetchStakingPool } from './lib/top-up-utils.js';
import { batchTransferTokensToRewardPools, prepareBatchTransaction } from './lib/transfer.js';
import type { PoolConfig, PoolResult } from './lib/types.js';

const dryRun = parseInt(process.env.DRY_RUN || '0') === 1;
const logger = createLogger({ dryRun, verbose: process.env.DEBUG_LOG === 'true' });
const solBalanceWarningThreshold = process.env.SOL_BALANCE_WARNING_THRESHOLD
  ? new BN(process.env.SOL_BALANCE_WARNING_THRESHOLD)
  : undefined;

const connection = new Connection(
  invariant(process.env.RPC_URL, 'RPC_URL is required') ?? process.env.RPC_URL,
  'confirmed',
);

const poolConfigs =
  invariant(process.env.POOL_CONFIGS, 'POOL_CONFIGS are required') ??
  (JSON.parse(process.env.POOL_CONFIGS) as Array<PoolConfig>);

async function processStakePool(pool: PoolConfig) {
  logger.log(`Processing pool: id - ${pool.id}, name - ${pool.name}`);

  const keypair = parseKeypairSync(pool.privateKey);

  const stakingPool = await fetchStakingPool(connection, pool.stakePoolAddress, pool.isToken2022, pool?.feeValue);

  const funderAccounts = await fetchFunderBalances(
    connection,
    pool.privateKey,
    stakingPool.mint,
    pool.isToken2022,
    logger,
  );

  if (funderAccounts.solAmount.lte(new BN(0))) {
    const message = `Pool ${pool.name}: Not enough SOL balance in wallet ${funderAccounts.walletPubkey.toString()} to top-up`;

    logger.error(message);

    await notify('Insufficient SOL balance', message, logger);

    return {
      id: pool.id,
      poolName: pool.name,
      currentStaked: stakingPool.tvl.toString(),
      funderTokenAccountBalance: funderAccounts.tokenAmount.toString(),
      requiredTopUp: 'N/A',
      txSignature: 'N/A',
    };
  }

  if (solBalanceWarningThreshold && funderAccounts.solAmount.lte(solBalanceWarningThreshold)) {
    const message = `Pool ${pool.name}: SOL balance is low: ${funderAccounts.solAmount.toString()}, threshold: ${solBalanceWarningThreshold.toString()}`;

    logger.warn(message);

    await notify('Low SOL balance', message, logger);
  }

  const requiredTokens = calculateTokensNeededForTargetAPY(stakingPool, pool.targetAPY, pool.fundingPeriodMinutes);

  if (requiredTokens.totalTokensNeeded.lte(new BN(0))) {
    logger.log(`Pool ${pool.name}: No top-up needed`);

    return {
      id: pool.id,
      poolName: pool.name,
      currentStaked: stakingPool.tvl.toString(),
      requiredTopUp: requiredTokens.totalTokensNeeded.toString(),
      funderTokenAccountBalance: funderAccounts.tokenAmount.toString(),
      txSignature: 'N/A',
    };
  }

  if (requiredTokens.totalTokensNeeded.gt(funderAccounts.tokenAmount)) {
    logger.error(`Pool ${pool.name}: Not enough balance in wallet to top-up`);

    return {
      id: pool.id,
      poolName: pool.name,
      currentStaked: stakingPool.tvl.toString(),
      funderTokenAccountBalance: funderAccounts.tokenAmount.toString(),
      requiredTopUp: requiredTokens.totalTokensNeeded.toString(),
      txSignature: 'N/A',
    };
  }

  const batch = await prepareBatchTransaction(
    connection,
    keypair,
    keypair.publicKey,
    TOKEN_PROGRAM_ID,
    requiredTokens.tokensNeededPerPool.map((rewardPool) => ({
      mint: rewardPool.mint,
      recipient: new PublicKey(rewardPool.poolAddress),
      amount: rewardPool.tokensNeeded,
    })),
    COMPUTE_PRICE,
    requiredTokens.tokensNeededPerPool.length * DEFAULT_CU,
  );

  if (!batch) {
    throw new Error('Failed to prepare batch transaction');
  }

  const { tx } = batch;

  const cost = await estimateCompleteTransactionCost(connection, tx, logger);

  if (new BN(cost.totalFeeSOL).gt(funderAccounts.solAmount)) {
    await notify(
      'Insufficient SOL balance',
      `Pool ${pool.name}: Not enough SOL balance in wallet ${funderAccounts.walletPubkey.toString()} to top-up`,
      logger,
    );

    return {
      id: pool.id,
      poolName: pool.name,
      currentStaked: stakingPool.tvl.toString(),
      funderTokenAccountBalance: funderAccounts.tokenAmount.toString(),
      requiredTopUp: requiredTokens.totalTokensNeeded.toString(),
      txSignature: 'N/A',
    };
  }

  // Execute top-up if needed
  let txSignature: string | undefined = undefined;

  if (requiredTokens.totalTokensNeeded.gt(new BN(0))) {
    try {
      txSignature = await batchTransferTokensToRewardPools(
        connection,
        keypair,
        keypair.publicKey,
        TOKEN_PROGRAM_ID,
        requiredTokens.tokensNeededPerPool.map((rewardPool) => ({
          mint: rewardPool.mint,
          recipient: new PublicKey(rewardPool.poolAddress),
          amount: rewardPool.tokensNeeded,
          feeValue: rewardPool.feeValue,
        })),
        COMPUTE_PRICE,
        requiredTokens.tokensNeededPerPool.length * DEFAULT_CU,
        SEND_THROTTLER,
        dryRun,
        logger,
      );

      logger.log(`Pool id - ${pool.id}, pool name - ${pool.name}: Top-up completed. tx - ${txSignature || 'N/A'}`);
    } catch (error) {
      const message = `Pool id - ${pool.id}, pool name - ${pool.name}: Top-up failed: ${error instanceof Error ? error.message : 'Unknown error'}`;

      logger.error(message);

      await notify('Top-up failed', message, logger);

      return {
        id: pool.id,
        poolName: pool.name,
        currentStaked: stakingPool.tvl.toString(),
        funderTokenAccountBalance: funderAccounts.tokenAmount.toString(),
        requiredTopUp: requiredTokens.totalTokensNeeded.toString(),
        txSignature: 'N/A',
      };
    }
  } else {
    logger.log(`Pool id - ${pool.id}, pool name - ${pool.name}: No top-up needed`);
  }

  return {
    id: pool.id,
    poolName: pool.name,
    currentStaked: stakingPool.tvl.toString(),
    funderTokenAccountBalance: funderAccounts.tokenAmount.toString(),
    requiredTopUp: requiredTokens.totalTokensNeeded.toString(),
    txSignature: txSignature || 'N/A',
  };
}

async function main() {
  logger.group(`Top up ASR pools - ${poolConfigs.length} pools configured`);

  const result = [
    [
      'Timestamp',
      'Pool ID',
      'Pool Name',
      'Staked Amount',
      'Funder Token Account Balance',
      'Total Top-up Amount',
      'Tx Signature',
    ],
  ];

  try {
    // Filter pools based on funding period
    const filteredPools = poolConfigs.filter(
      (pool) =>
        pool.fundingPeriodMinutes ===
        parseInt(
          invariant(process.env.PERIOD_IN_MINUTES, 'PERIOD_IN_MINUTES is required') ?? process.env.PERIOD_IN_MINUTES,
        ),
    );

    logger.group(`Processing ${filteredPools.length} pools for period: ${process.env.PERIOD_IN_MINUTES} minutes`);

    const poolResults: PoolResult[] = [];

    for (const pool of filteredPools) {
      const result = await processStakePool(pool);

      poolResults.push(result);
    }

    // Add results to CSV
    poolResults.forEach((poolResult) => {
      result.push([
        new Date().toISOString(),
        poolResult.id,
        poolResult.poolName,
        poolResult.currentStaked,
        poolResult.funderTokenAccountBalance,
        poolResult.requiredTopUp,
        poolResult.txSignature,
      ]);
    });

    logger.groupEnd();

    // Simple summary
    logger.group('Summary');

    poolResults.forEach((poolResult) => {
      logger.log(`Pool id - ${poolResult.id}, pool name - ${poolResult.poolName}, tx - ${poolResult.txSignature}`);
    });

    logger.groupEnd();
  } catch (error) {
    const message = `Error: ${error instanceof Error ? error.message : 'Unknown error'}`;

    logger.error(message);

    await notify('Error in ASR pools worker', message, logger);

    throw error;
  }

  logger.groupEnd();

  if (dryRun) {
    logger.log('Results:', result);

    return;
  }

  // Write results (remain as artifacts of the run)
  const writeStream = createWriteStream('/tmp/result.csv');
  result.forEach((item) => writeStream.write(item.join(',') + '\n'));
  writeStream.end();
}

(async () => {
  await main();
})();
