import type { PublicKey } from '@solana/web3.js';
import type BN from 'bn.js';

/**
 * Base configuration shared by all pool types
 */
export interface BasePoolConfig {
  id: string;
  name: string;
  stakePoolAddress: string;
  privateKey: string;
  fundingPeriodMinutes: number;
  feeValue?: string | undefined | null;
  isToken2022: boolean;
}

/**
 * APY-based pool configuration (existing behavior)
 * Calculates tokens needed to achieve a target APY
 */
export interface ApyBasedPoolConfig extends BasePoolConfig {
  mode: 'apy-based';
  targetAPY: number;
}

/**
 * Revenue-based pool configuration (new behavior)
 * Distributes actual revenue from an external source
 */
export interface RevenueBasedPoolConfig extends BasePoolConfig {
  mode: 'revenue-based';
  /** API endpoint that returns the amount to distribute */
  revenueApiEndpoint: string;
  /** Optional: Header name for API authentication (e.g., 'X-API-Key') */
  revenueApiAuthHeader?: string;
  /** Optional: Environment variable name containing the auth token */
  revenueApiAuthTokenEnvVar?: string;
  /** Optional: Mint address of the reward token (for validation) */
  rewardTokenMint?: string;
  /** Whether the reward token is Token2022 (can differ from stake token) */
  isRewardToken2022?: boolean;
}

/**
 * Legacy pool configuration (for backwards compatibility)
 * Treated as apy-based mode
 */
export interface LegacyPoolConfig extends BasePoolConfig {
  mode?: undefined;
  targetAPY: number;
}

/**
 * Union type for all pool configurations
 */
export type PoolConfig = ApyBasedPoolConfig | RevenueBasedPoolConfig | LegacyPoolConfig;

/**
 * Response expected from the revenue API endpoint
 */
export interface RevenueApiResponse {
  /** Amount to distribute in smallest units (lamports for SOL, etc.) */
  amount: string;
  /** Optional: Mint address for validation */
  mint?: string;
}

export interface RewardPool {
  address: string;
  mint: string;
  vault: string;
  fundedAmount: BN;
  claimedAmount: BN;
  rewardsState: BN;
  lastAmount: BN;
  createdTs: BN;
  decimals: number;
}

export interface StakingPool {
  rewardPools: RewardPool[];
  tvl: BN;
  mint: string;
  decimals: number;
  feeValue?: string | undefined | null;
}

export interface TransactionCostResult {
  totalFeeLamports: number;
  totalFeeSOL: number;
  computeUnits: number | undefined;
}

export interface NotifyMessage {
  title: string;
  message: string;
  workflow: string;
  runUrl: string;
}

export interface PoolResult {
  id: string;
  poolName: string;
  currentStaked: string;
  funderTokenAccountBalance: string;
  requiredTopUp: string;
  txSignature: string;
}

export interface BatchTransferItem {
  mint: string;
  recipient: PublicKey;
  amount: BN | bigint;
  feeValue?: string | undefined | null;
  isToken2022: boolean;
}
