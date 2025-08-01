import { getAccount, getAssociatedTokenAddressSync, unpackMint } from '@solana/spl-token';
import { Connection, LAMPORTS_PER_SOL, PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js';
import { getFilters, isTransactionVersioned, pk } from '@streamflow/common/solana';
import BN from 'bn.js';
import { createRewardPoolDynamicClient, createStakingClient } from './client.js';
import { parseKeypairSync } from './keypair.js';
import type { RewardPool, StakingPool, TransactionCostResult } from './types.js';

/**
 * Fetch the staking pool for a given stake pool address
 * @param {Connection} connection - connection to the blockchain
 * @param {string} stakePoolAddress - stake pool address
 * @returns {Promise<StakingPool>} staking pool
 */
export async function fetchStakingPool(
  connection: Connection,
  stakePoolAddress: string,
  feeValue?: string | undefined | null,
): Promise<StakingPool> {
  const stakePoolClient = createStakingClient();

  const stakePool = await stakePoolClient.account.stakePool.fetch(stakePoolAddress);
  const mintInfo = await fetchMintInfo([stakePool.mint.toString()], connection);
  const decimals = mintInfo.at(0)?.decimals ?? 9;

  const rewardPools = await fetchRewardPools(connection, stakePoolAddress);

  return {
    rewardPools,
    tvl: stakePool.totalStake,
    mint: stakePool.mint.toString(),
    decimals,
    feeValue,
  };
}

/**
 * Fetch the reward pools for a given stake pool
 * @param {Connection} connection - connection to the blockchain
 * @param {string} stakePoolAddress - stake pool address
 * @returns {Promise<RewardPool[]>} reward pools
 */
export async function fetchRewardPools(connection: Connection, stakePoolAddress: string): Promise<RewardPool[]> {
  const rewardPoolClient = createRewardPoolDynamicClient();

  const rewardPools = await rewardPoolClient.account.rewardPool.all(
    getFilters(
      {
        stakePool: pk(stakePoolAddress),
      },
      {
        stakePool: 10,
      },
    ),
  );

  const mintInfo = await fetchMintInfo(
    rewardPools.map((pool) => pool.account.mint.toString()),
    connection,
  );

  const mintInfoMap = new Map(mintInfo.map((info) => [info.publicKey, info]));

  return rewardPools.map((pool) => {
    const mint = mintInfoMap.get(pool.account.mint.toString());

    if (!mint) {
      throw new Error(`Mint not found for pool ${pool.publicKey.toString()}`);
    }

    return {
      address: pool.publicKey.toString(),
      vault: pool.account.vault.toString(),
      fundedAmount: pool.account.fundedAmount,
      claimedAmount: pool.account.claimedAmount,
      rewardsState: pool.account.rewardsState,
      lastAmount: pool.account.lastAmount,
      createdTs: pool.account.createdTs,
      mint: mint.publicKey,
      decimals: mint.decimals,
    };
  });
}

/**
 * Fetch the token balance of a given mint for a given funder
 * @param {Connection} connection - connection to the blockchain
 * @param {string} privateKey - private key string
 * @param {string} mint - mint address string
 * @param {Console} logger - logger to use (optional)
 * @returns {Promise<{ walletPubkey: PublicKey; solAmount: BN; tokenAccountPubkey: PublicKey; tokenAmount: BN }>} wallet and token balances for a given funder
 */
export async function fetchFunderBalances(
  connection: Connection,
  privateKey: string,
  mint: string,
  logger?: Console,
): Promise<{ walletPubkey: PublicKey; solAmount: BN; tokenAccountPubkey: PublicKey; tokenAmount: BN }> {
  const keypair = parseKeypairSync(privateKey);

  const tokenAccountPubkey = getAssociatedTokenAddressSync(new PublicKey(mint), keypair.publicKey);

  try {
    const [walletBalance, tokenAccount] = await Promise.all([
      connection.getBalance(keypair.publicKey),
      getAccount(connection, tokenAccountPubkey),
    ]);

    return {
      walletPubkey: keypair.publicKey,
      solAmount: new BN(walletBalance.toString()),
      tokenAccountPubkey: tokenAccount.address,
      tokenAmount: new BN(tokenAccount.amount.toString()),
    };
  } catch (error) {
    logger?.warn(`Failed to fetch token balance: ${error}`);

    return {
      walletPubkey: keypair.publicKey,
      solAmount: new BN(0),
      tokenAccountPubkey: new PublicKey(0),
      tokenAmount: new BN(0),
    };
  }
}

/**
 * Fetch the mint info for a given mint
 * @param {string[]} publicKeys - array of mint public keys
 * @param {Connection} connection - connection to the blockchain
 * @returns {Promise<{ publicKey: string; decimals: number }[]>} mint info
 */
export async function fetchMintInfo(
  publicKeys: string[],
  connection: Connection,
): Promise<{ publicKey: string; decimals: number }[]> {
  const accounts = await connection.getMultipleAccountsInfo(publicKeys.map((key) => new PublicKey(key)));

  const mintInfo = accounts
    .map((account, index) => {
      if (!account) {
        return null;
      }

      try {
        const mint = unpackMint(new PublicKey(publicKeys[index]!), account);

        return {
          publicKey: mint.address.toString(),
          decimals: mint.decimals,
        };
      } catch (error) {
        console.warn(`Failed to unpack mint for ${publicKeys[index]}:`, error);
        return null;
      }
    })
    .filter((info) => info !== null);

  return mintInfo;
}

/**
 * Get the transaction fee for a given transaction
 * @param {Connection} connection - connection to the blockchain
 * @param {Transaction | VersionedTransaction} tx - transaction to get the fee for
 * @returns {Promise<number | null>} transaction fee in lamports
 */
export async function getTransactionFee(
  connection: Connection,
  tx: Transaction | VersionedTransaction,
): Promise<number | null> {
  const message = isTransactionVersioned(tx) ? tx.message : tx.compileMessage();

  const { value: fee } = await connection.getFeeForMessage(message, 'confirmed');

  return fee;
}

/**
 * Estimate the complete transaction cost for a given transaction
 * @param {Connection} connection - connection to the blockchain
 * @param {Transaction | VersionedTransaction} tx - transaction to estimate the cost for
 * @returns {Promise<TransactionCostResult>} transaction cost result
 */
export async function estimateCompleteTransactionCost(
  connection: Connection,
  transaction: VersionedTransaction,
  logger?: Console,
): Promise<TransactionCostResult> {
  // 1. Simulate the VersionedTransaction using the current API
  const simulation = await connection.simulateTransaction(transaction, {
    sigVerify: false,
    commitment: 'confirmed',
    innerInstructions: true,
  });

  if (simulation.value.err) {
    throw new Error(`Simulation failed: ${JSON.stringify(simulation.value.err)}`);
  }

  logger?.debug(simulation.value.logs);

  // 2. Get the transaction fee using VersionedTransaction message
  const { value: totalFee } = await connection.getFeeForMessage(transaction.message);

  if (totalFee === null) {
    throw new Error('Failed to estimate transaction fee');
  }

  return {
    totalFeeLamports: totalFee,
    totalFeeSOL: totalFee / LAMPORTS_PER_SOL,
    computeUnits: simulation.value.unitsConsumed,
  };
}
