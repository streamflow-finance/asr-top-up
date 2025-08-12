import type { PublicKey } from '@solana/web3.js';
import type BN from 'bn.js';

export interface PoolConfig {
  id: string;
  name: string;
  stakePoolAddress: string;
  privateKey: string;
  targetAPY: number;
  fundingPeriodMinutes: number;
  feeValue?: string | undefined | null;
  isToken2022: boolean;
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
