import { IdlAccounts, Program } from '@coral-xyz/anchor';
import { Connection } from '@solana/web3.js';
import { invariant } from '@streamflow/common';
import type { RewardPoolDynamic as RewardPoolDynamicProgramType } from '../idl/reward-pool-dynamic/reward_pool_dynamic.js';
import RewardPoolDynamicIdl from '../idl/reward-pool-dynamic/reward_pool_dynamic.json' with { type: 'json' };
import type { StakePool as StakePoolProgramType } from '../idl/stake-pool/stake_pool.js';
import StakePoolIdl from '../idl/stake-pool/stake_pool.json' with { type: 'json' };

export const createStakingClient = () => {
  const program = new Program(StakePoolIdl as StakePoolProgramType, {
    connection: new Connection(
      invariant(process.env.RPC_URL, 'RPC_URL is required') ?? process.env.RPC_URL,
      'confirmed',
    ),
  }) as Program<StakePoolProgramType>;

  return program;
};

export type StakePoolClientAccounts = IdlAccounts<StakePoolProgramType>;

export const createRewardPoolDynamicClient = () => {
  const program = new Program(RewardPoolDynamicIdl as RewardPoolDynamicProgramType, {
    connection: new Connection(
      invariant(process.env.RPC_URL, 'RPC_URL is required') ?? process.env.RPC_URL,
      'confirmed',
    ),
  }) as Program<RewardPoolDynamicProgramType>;

  return program;
};

export type RewardPoolDynamicClientAccounts = IdlAccounts<RewardPoolDynamicProgramType>;
