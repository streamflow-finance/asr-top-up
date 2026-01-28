import { Connection, PublicKey } from '@solana/web3.js';
import { invariant } from '@streamflow/common';
import BN from 'bn.js';
import { createWriteStream } from 'fs';
import { calculateTokensNeededForTargetAPY } from './lib/apy-token-based.js';
import { calculateRealizedAPY, calculateRevenueDistribution } from './lib/revenue-based.js';
import { COMPUTE_PRICE, DEFAULT_CU, SEND_THROTTLER } from './lib/constants.js';
import { parseKeypairSync } from './lib/keypair.js';
import { createLogger } from './lib/logger.js';
import { notify } from './lib/notify.js';
import {
  ensureWsolBalance,
  estimateCompleteTransactionCost,
  fetchFunderBalances,
  fetchStakingPool,
  fetchFunderBalancesForMint,
  isWsolMint,
} from './lib/top-up-utils.js';
import { batchTransferTokensToRewardPools, prepareBatchTransaction } from './lib/transfer.js';
import type { PoolConfig, PoolResult, RevenueBasedPoolConfig } from './lib/types.js';

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

/**
 * Determine if a pool config is revenue-based
 */
function isRevenueBasedPool(pool: PoolConfig): pool is RevenueBasedPoolConfig {
  return pool.mode === 'revenue-based';
}

/**
 * Process an APY-based pool (existing behavior)
 */
async function processApyBasedPool(pool: PoolConfig): Promise<PoolResult> {
  logger.log(`Processing APY-based pool: id - ${pool.id}, name - ${pool.name}`);

  // Type guard: ensure we have targetAPY for APY-based pools
  if (!('targetAPY' in pool)) {
    throw new Error(`Pool ${pool.name}: targetAPY is required for APY-based mode`);
  }

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
    requiredTokens.tokensNeededPerPool.map((rewardPool) => ({
      mint: rewardPool.mint,
      recipient: new PublicKey(rewardPool.poolAddress),
      amount: rewardPool.tokensNeeded,
      isToken2022: pool.isToken2022,
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

  let txSignature: string | undefined = undefined;

  if (requiredTokens.totalTokensNeeded.gt(new BN(0))) {
    try {
      txSignature = await batchTransferTokensToRewardPools(
        connection,
        keypair,
        keypair.publicKey,
        requiredTokens.tokensNeededPerPool.map((rewardPool) => ({
          mint: rewardPool.mint,
          recipient: new PublicKey(rewardPool.poolAddress),
          amount: rewardPool.tokensNeeded,
          feeValue: rewardPool.feeValue,
          isToken2022: pool.isToken2022,
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

/**
 * Process a revenue-based pool (new behavior)
 * Fetches distribution amount from client API and distributes actual revenue
 */
async function processRevenueBasedPool(pool: RevenueBasedPoolConfig): Promise<PoolResult> {
  logger.log(`Processing revenue-based pool: id - ${pool.id}, name - ${pool.name}`);

  const keypair = parseKeypairSync(pool.privateKey);
  const stakingPool = await fetchStakingPool(connection, pool.stakePoolAddress, pool.isToken2022, pool?.feeValue);

  // For revenue-based pools, fetch the distribution amount from the API
  let requiredTokens;
  try {
    requiredTokens = await calculateRevenueDistribution(stakingPool, pool, logger);
  } catch (error) {
    const message = `Pool ${pool.name}: Failed to fetch revenue amount: ${error instanceof Error ? error.message : 'Unknown error'}`;
    logger.error(message);
    await notify('Revenue API Error', message, logger);
    return {
      id: pool.id,
      poolName: pool.name,
      currentStaked: stakingPool.tvl.toString(),
      funderTokenAccountBalance: 'N/A',
      requiredTopUp: 'N/A',
      txSignature: 'N/A',
    };
  }

  if (requiredTokens.totalTokensNeeded.lte(new BN(0))) {
    logger.log(`Pool ${pool.name}: No revenue to distribute`);
    return {
      id: pool.id,
      poolName: pool.name,
      currentStaked: stakingPool.tvl.toString(),
      requiredTopUp: '0',
      funderTokenAccountBalance: 'N/A',
      txSignature: 'N/A',
    };
  }

  // For revenue-based pools, the reward token may differ from stake token
  const rewardTokenMint = requiredTokens.tokensNeededPerPool[0]?.mint;
  if (!rewardTokenMint) {
    throw new Error('No reward token mint found');
  }

  const isRewardToken2022 = pool.isRewardToken2022 ?? pool.isToken2022;

  const funderAccounts = await fetchFunderBalancesForMint(
    connection,
    pool.privateKey,
    rewardTokenMint,
    isRewardToken2022,
    logger,
  );

  if (funderAccounts.solAmount.lte(new BN(0))) {
    const message = `Pool ${pool.name}: Not enough SOL balance in wallet ${funderAccounts.walletPubkey.toString()} for transaction fees`;
    logger.error(message);
    await notify('Insufficient SOL balance', message, logger);
    return {
      id: pool.id,
      poolName: pool.name,
      currentStaked: stakingPool.tvl.toString(),
      funderTokenAccountBalance: funderAccounts.tokenAmount.toString(),
      requiredTopUp: requiredTokens.totalTokensNeeded.toString(),
      txSignature: 'N/A',
    };
  }

  if (solBalanceWarningThreshold && funderAccounts.solAmount.lte(solBalanceWarningThreshold)) {
    const message = `Pool ${pool.name}: SOL balance is low: ${funderAccounts.solAmount.toString()}, threshold: ${solBalanceWarningThreshold.toString()}`;
    logger.warn(message);
    await notify('Low SOL balance', message, logger);
  }

  // Check if reward token is wSOL and if we need to wrap native SOL
  if (isWsolMint(rewardTokenMint) && requiredTokens.totalTokensNeeded.gt(funderAccounts.tokenAmount)) {
    logger.log(
      `Pool ${pool.name}: wSOL balance insufficient (${funderAccounts.tokenAmount.toString()}), checking if we can wrap native SOL...`,
    );

    const wrapSuccess = await ensureWsolBalance(
      connection,
      keypair,
      requiredTokens.totalTokensNeeded,
      funderAccounts.tokenAmount,
      funderAccounts.solAmount,
      dryRun,
      logger,
    );

    if (wrapSuccess) {
      // Re-fetch balances after wrapping
      const updatedFunderAccounts = await fetchFunderBalancesForMint(
        connection,
        pool.privateKey,
        rewardTokenMint,
        isRewardToken2022,
        logger,
      );
      // Update the reference for subsequent checks
      funderAccounts.tokenAmount = updatedFunderAccounts.tokenAmount;
      funderAccounts.solAmount = updatedFunderAccounts.solAmount;
      logger.log(`Pool ${pool.name}: After wrapping, wSOL balance: ${funderAccounts.tokenAmount.toString()}`);
    } else {
      const message = `Pool ${pool.name}: Failed to wrap SOL to wSOL. Required: ${requiredTokens.totalTokensNeeded.toString()}, wSOL Available: ${funderAccounts.tokenAmount.toString()}, Native SOL: ${funderAccounts.solAmount.toString()}`;
      logger.error(message);
      await notify('Insufficient balance for wSOL wrap', message, logger);
      return {
        id: pool.id,
        poolName: pool.name,
        currentStaked: stakingPool.tvl.toString(),
        funderTokenAccountBalance: funderAccounts.tokenAmount.toString(),
        requiredTopUp: requiredTokens.totalTokensNeeded.toString(),
        txSignature: 'N/A',
      };
    }
  }

  // Final check for sufficient reward token balance
  if (requiredTokens.totalTokensNeeded.gt(funderAccounts.tokenAmount)) {
    const message = `Pool ${pool.name}: Not enough reward token balance in wallet to distribute. Required: ${requiredTokens.totalTokensNeeded.toString()}, Available: ${funderAccounts.tokenAmount.toString()}`;
    logger.error(message);
    await notify('Insufficient reward token balance', message, logger);
    return {
      id: pool.id,
      poolName: pool.name,
      currentStaked: stakingPool.tvl.toString(),
      funderTokenAccountBalance: funderAccounts.tokenAmount.toString(),
      requiredTopUp: requiredTokens.totalTokensNeeded.toString(),
      txSignature: 'N/A',
    };
  }

  // Calculate and log realized APY for informational purposes
  const realizedAPY = calculateRealizedAPY(
    requiredTokens.totalTokensNeeded,
    stakingPool.tvl,
    pool.fundingPeriodMinutes,
  );
  logger.log(`Pool ${pool.name}: Realized APY for this distribution: ${realizedAPY}%`);

  const batch = await prepareBatchTransaction(
    connection,
    keypair,
    keypair.publicKey,
    requiredTokens.tokensNeededPerPool.map((rewardPool) => ({
      mint: rewardPool.mint,
      recipient: new PublicKey(rewardPool.poolAddress),
      amount: rewardPool.tokensNeeded,
      isToken2022: isRewardToken2022,
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
      `Pool ${pool.name}: Not enough SOL balance in wallet ${funderAccounts.walletPubkey.toString()} for transaction fees`,
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

  let txSignature: string | undefined = undefined;

  try {
    txSignature = await batchTransferTokensToRewardPools(
      connection,
      keypair,
      keypair.publicKey,
      requiredTokens.tokensNeededPerPool.map((rewardPool) => ({
        mint: rewardPool.mint,
        recipient: new PublicKey(rewardPool.poolAddress),
        amount: rewardPool.tokensNeeded,
        feeValue: rewardPool.feeValue,
        isToken2022: isRewardToken2022,
      })),
      COMPUTE_PRICE,
      requiredTokens.tokensNeededPerPool.length * DEFAULT_CU,
      SEND_THROTTLER,
      dryRun,
      logger,
    );
    logger.log(
      `Pool id - ${pool.id}, pool name - ${pool.name}: Revenue distribution completed. tx - ${txSignature || 'N/A'}`,
    );
  } catch (error) {
    const message = `Pool id - ${pool.id}, pool name - ${pool.name}: Revenue distribution failed: ${error instanceof Error ? error.message : 'Unknown error'}`;
    logger.error(message);
    await notify('Revenue distribution failed', message, logger);
    return {
      id: pool.id,
      poolName: pool.name,
      currentStaked: stakingPool.tvl.toString(),
      funderTokenAccountBalance: funderAccounts.tokenAmount.toString(),
      requiredTopUp: requiredTokens.totalTokensNeeded.toString(),
      txSignature: 'N/A',
    };
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

/**
 * Process a stake pool based on its mode (APY-based or revenue-based)
 */
async function processStakePool(pool: PoolConfig): Promise<PoolResult> {
  if (isRevenueBasedPool(pool)) {
    return processRevenueBasedPool(pool);
  }
  return processApyBasedPool(pool);
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
