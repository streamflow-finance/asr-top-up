import BN from 'bn.js';
import { MINUTES_IN_YEAR, PRECISION_DECIMALS } from './constants.js';
import type { StakingPool } from './types.js';

/**
 * Calculate the tokens needed for a given staking pool, funding frequency, target APY, and distribution strategy
 * @param {StakingPool} stakingPool - staking pool
 * @param {number} fundingFrequencyMinutes - funding frequency minutes
 * @param {number} targetAPY - target APY
 * @param {'proportional' | 'single_pool'} distributionStrategy - distribution strategy
 * @param {number} targetPoolIndex - target pool index
 * @returns {Object} tokens needed per pool
 */
export function calculateTokensNeededForTargetAPY(
  stakingPool: StakingPool,
  fundingFrequencyMinutes: number,
  targetAPY: number,
  distributionStrategy: 'proportional' | 'single_pool' = 'proportional',
  targetPoolIndex?: number,
): {
  totalTokensNeeded: BN;
  tokensNeededPerPool: Array<{
    poolAddress: string;
    mint: string;
    tokensNeeded: BN;
    feeValue?: string | undefined | null;
  }>;
} {
  let totalTokensNeeded = new BN(0);

  const tokensNeededPerPool: Array<{
    poolAddress: string;
    mint: string;
    tokensNeeded: BN;
    feeValue?: string | undefined | null;
  }> = [];

  if (distributionStrategy === 'single_pool') {
    // Single pool strategy: only calculate for the specified pool
    if (targetPoolIndex === undefined || targetPoolIndex < 0 || targetPoolIndex >= stakingPool.rewardPools.length) {
      throw new Error('targetPoolIndex must be specified and valid for single_pool strategy');
    }

    const pool = stakingPool.rewardPools[targetPoolIndex];

    if (!pool) {
      throw new Error(`Pool index ${targetPoolIndex} does not exist`);
    }

    const tokensNeeded = calculateIntervalReward(stakingPool.tvl, new BN(targetAPY), fundingFrequencyMinutes);

    totalTokensNeeded = tokensNeeded;

    tokensNeededPerPool.push({
      poolAddress: pool.address,
      mint: pool.mint,
      tokensNeeded,
      feeValue: stakingPool.feeValue,
    });
  } else {
    // Proportional strategy: calculate for all pools
    for (const pool of stakingPool.rewardPools) {
      const tokensNeeded = calculateIntervalReward(stakingPool.tvl, new BN(targetAPY), fundingFrequencyMinutes);

      totalTokensNeeded = totalTokensNeeded.add(tokensNeeded);

      tokensNeededPerPool.push({
        poolAddress: pool.address,
        mint: pool.mint,
        tokensNeeded,
        feeValue: stakingPool.feeValue,
      });
    }
  }

  return {
    totalTokensNeeded,
    tokensNeededPerPool,
  };
}

/**
 * Calculate the interval reward for a given total staked, annual rate, and interval minutes
 * @param {BN} totalStaked - total staked amount
 * @param {BN} annualRate - annual rate e.g., 8 (for 8% APY)
 * @param {number} intervalMinutes - interval minutes
 * @returns {BN} interval reward
 */
export function calculateIntervalReward(totalStaked: BN, annualRate: BN, intervalMinutes: number): BN {
  // If no stake, no rewards
  if (totalStaked.lte(new BN(0))) {
    return new BN(0);
  }

  const minutesInYear = new BN(MINUTES_IN_YEAR);
  const interval = new BN(intervalMinutes);
  const precisionBN = new BN(10).pow(new BN(PRECISION_DECIMALS));
  const hundred = new BN(100);

  // reward = totalStaked * (annualRate / 100) * (interval / minutesInYear)
  // Using integer math: multiply all, then divide at the end

  const numerator = totalStaked.mul(annualRate).mul(interval).mul(precisionBN); // precision pushed up here to avoid losing scale

  const denominator = hundred.mul(minutesInYear).mul(precisionBN); // align scale

  return numerator.div(denominator);
}
