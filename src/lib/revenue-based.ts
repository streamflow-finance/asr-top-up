import BN from 'bn.js';
import type { RevenueApiResponse, RevenueBasedPoolConfig, StakingPool } from './types.js';

/**
 * Fetch the distribution amount from the client's revenue API endpoint
 * @param config - Revenue-based pool configuration
 * @param logger - Optional logger
 * @returns The amount to distribute and optional mint for validation
 */
export async function fetchRevenueAmount(
  config: RevenueBasedPoolConfig,
  logger?: Console,
): Promise<{ amount: BN; mint?: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  // Add authentication header if configured
  if (config.revenueApiAuthHeader && config.revenueApiAuthTokenEnvVar) {
    const authToken = process.env[config.revenueApiAuthTokenEnvVar];
    if (authToken) {
      headers[config.revenueApiAuthHeader] = authToken;
    } else {
      logger?.warn(
        `Auth token environment variable ${config.revenueApiAuthTokenEnvVar} is not set, proceeding without authentication`,
      );
    }
  }

  logger?.log(`Fetching revenue amount from: ${config.revenueApiEndpoint}`);

  const response = await fetch(config.revenueApiEndpoint, {
    method: 'GET',
    headers,
  });

  if (!response.ok) {
    throw new Error(`Revenue API request failed: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as RevenueApiResponse;

  if (!data.amount) {
    throw new Error('Revenue API response missing required "amount" field');
  }

  // Validate amount is a valid number string
  const amount = new BN(data.amount);

  if (amount.isNeg()) {
    throw new Error('Revenue API returned negative amount');
  }

  logger?.log(`Revenue API returned amount: ${amount.toString()}${data.mint ? `, mint: ${data.mint}` : ''}`);

  return {
    amount,
    mint: data.mint,
  };
}

/**
 * Calculate tokens to distribute for revenue-based mode
 * This function fetches the amount from the API and prepares the distribution
 *
 * @param stakingPool - The staking pool data
 * @param config - Revenue-based pool configuration
 * @param logger - Optional logger
 * @returns Distribution details per reward pool
 */
export async function calculateRevenueDistribution(
  stakingPool: StakingPool,
  config: RevenueBasedPoolConfig,
  logger?: Console,
): Promise<{
  totalTokensNeeded: BN;
  tokensNeededPerPool: Array<{
    poolAddress: string;
    mint: string;
    tokensNeeded: BN;
    feeValue?: string | undefined | null;
  }>;
}> {
  const { amount, mint: apiMint } = await fetchRevenueAmount(config, logger);

  // Find the matching reward pool
  // If rewardTokenMint is specified, use that; otherwise use the API-provided mint
  const targetMint = config.rewardTokenMint || apiMint;

  let targetPool = stakingPool.rewardPools[0]; // Default to first pool

  if (targetMint) {
    const foundPool = stakingPool.rewardPools.find((pool) => pool.mint === targetMint);

    if (foundPool) {
      targetPool = foundPool;
    } else {
      logger?.warn(
        `Reward pool with mint ${targetMint} not found, using first available pool: ${stakingPool.rewardPools[0]?.mint}`,
      );
    }
  }

  if (!targetPool) {
    throw new Error('No reward pools available for distribution');
  }

  // Validate mint matches if both config and API specify it
  if (config.rewardTokenMint && apiMint && config.rewardTokenMint !== apiMint) {
    logger?.warn(
      `Mint mismatch: config specifies ${config.rewardTokenMint}, API returned ${apiMint}. Using config value.`,
    );
  }

  return {
    totalTokensNeeded: amount,
    tokensNeededPerPool: [
      {
        poolAddress: targetPool.address,
        mint: targetPool.mint,
        tokensNeeded: amount,
        feeValue: stakingPool.feeValue,
      },
    ],
  };
}

/**
 * Calculate the realized APY based on distribution amount and TVL
 * This is informational only - for logging/reporting purposes
 *
 * @param distributionAmount - Amount being distributed
 * @param tvl - Total value locked in the staking pool
 * @param periodMinutes - Distribution period in minutes
 * @returns Annualized APY as a percentage
 */
export function calculateRealizedAPY(distributionAmount: BN, tvl: BN, periodMinutes: number): number {
  if (tvl.isZero() || tvl.isNeg()) {
    return 0;
  }

  const MINUTES_IN_YEAR = 525_600;

  // APY = (distribution / tvl) * (MINUTES_IN_YEAR / periodMinutes) * 100
  // Using floating point for display purposes only
  const distribution = parseFloat(distributionAmount.toString());
  const totalStaked = parseFloat(tvl.toString());
  const periodsPerYear = MINUTES_IN_YEAR / periodMinutes;

  const apy = (distribution / totalStaked) * periodsPerYear * 100;

  return Math.round(apy * 100) / 100; // Round to 2 decimal places
}
