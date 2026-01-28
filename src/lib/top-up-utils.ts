import {
  createAssociatedTokenAccountIdempotentInstruction,
  createSyncNativeInstruction,
  getAccount,
  getAssociatedTokenAddressSync,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  unpackMint,
} from '@solana/spl-token';
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
  sendAndConfirmTransaction,
} from '@solana/web3.js';
import { getFilters, isTransactionVersioned, pk } from '@streamflow/common/solana';
import BN from 'bn.js';
import { createRewardPoolDynamicClient, createStakingClient } from './client.js';
import { parseKeypairSync } from './keypair.js';
import type { RewardPool, StakingPool, TransactionCostResult } from './types.js';

/**
 * Fetch the staking pool for a given stake pool address
 * @param {Connection} connection - connection to the blockchain
 * @param {string} stakePoolAddress - stake pool address
 * @param {boolean} isToken2022 - whether the token is a token2022 token
 * @returns {Promise<StakingPool>} staking pool
 */
export async function fetchStakingPool(
  connection: Connection,
  stakePoolAddress: string,
  isToken2022: boolean,
  feeValue?: string | undefined | null,
): Promise<StakingPool> {
  const stakePoolClient = createStakingClient();

  const stakePool = await stakePoolClient.account.stakePool.fetch(stakePoolAddress);
  const mintInfo = await fetchMintInfo([stakePool.mint.toString()], isToken2022, connection);
  const decimals = mintInfo.at(0)?.decimals ?? 9;

  const rewardPools = await fetchRewardPools(connection, stakePoolAddress, isToken2022);

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
 * @param {boolean} isToken2022 - whether the token is a token2022 token
 * @returns {Promise<RewardPool[]>} reward pools
 */
export async function fetchRewardPools(
  connection: Connection,
  stakePoolAddress: string,
  isToken2022: boolean,
): Promise<RewardPool[]> {
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
    isToken2022,
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
 * @param {boolean} isToken2022 - whether the token is a token2022 token
 * @param {Console} logger - logger to use (optional)
 * @returns {Promise<{ walletPubkey: PublicKey; solAmount: BN; tokenAccountPubkey: PublicKey; tokenAmount: BN }>} wallet and token balances for a given funder
 */
export async function fetchFunderBalances(
  connection: Connection,
  privateKey: string,
  mint: string,
  isToken2022: boolean,
  logger?: Console,
): Promise<{ walletPubkey: PublicKey; solAmount: BN; tokenAccountPubkey: PublicKey; tokenAmount: BN }> {
  const keypair = parseKeypairSync(privateKey);

  const programId = isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;

  const tokenAccountPubkey = getAssociatedTokenAddressSync(
    new PublicKey(mint),
    keypair.publicKey,
    undefined,
    programId,
  );

  try {
    const [walletBalance, tokenAccount] = await Promise.all([
      connection.getBalance(keypair.publicKey),
      getAccount(connection, tokenAccountPubkey, undefined, programId),
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
 * Fetch the token balance for a specific mint (used for revenue-based pools where reward token differs from stake token)
 * @param {Connection} connection - connection to the blockchain
 * @param {string} privateKey - private key string
 * @param {string} mint - mint address string of the reward token
 * @param {boolean} isToken2022 - whether the reward token is a token2022 token
 * @param {Console} logger - logger to use (optional)
 * @returns {Promise<{ walletPubkey: PublicKey; solAmount: BN; tokenAccountPubkey: PublicKey; tokenAmount: BN }>} wallet and token balances
 */
export async function fetchFunderBalancesForMint(
  connection: Connection,
  privateKey: string,
  mint: string,
  isToken2022: boolean,
  logger?: Console,
): Promise<{ walletPubkey: PublicKey; solAmount: BN; tokenAccountPubkey: PublicKey; tokenAmount: BN }> {
  // This is essentially the same as fetchFunderBalances but explicitly named for clarity
  // when dealing with reward tokens that differ from stake tokens
  return fetchFunderBalances(connection, privateKey, mint, isToken2022, logger);
}

/**
 * Fetch the mint info for a given mint
 * @param {string[]} publicKeys - array of mint public keys
 * @param {boolean} isToken2022 - whether the token is a token2022 token
 * @param {Connection} connection - connection to the blockchain
 * @returns {Promise<{ publicKey: string; decimals: number }[]>} mint info
 */
export async function fetchMintInfo(
  publicKeys: string[],
  isToken2022: boolean,
  connection: Connection,
): Promise<{ publicKey: string; decimals: number }[]> {
  const accounts = await connection.getMultipleAccountsInfo(publicKeys.map((key) => new PublicKey(key)));

  const mintInfo = accounts
    .map((account, index) => {
      if (!account) {
        return null;
      }

      try {
        const mint = unpackMint(
          new PublicKey(publicKeys[index]!),
          account,
          isToken2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
        );

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
    logger?.error('Simulation logs: \n', simulation.value.logs);

    throw new Error('Simulation failed');
  }

  logger?.debug('Simulation logs: \n', simulation.value.logs);

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

/**
 * Check if a mint is wrapped SOL (wSOL)
 * @param {string} mint - mint address to check
 * @returns {boolean} true if the mint is wSOL
 */
export function isWsolMint(mint: string): boolean {
  return mint === NATIVE_MINT.toString();
}

/**
 * Wrap native SOL to wSOL (Wrapped SOL)
 * Creates a wSOL ATA if needed, transfers SOL to it, and syncs the balance
 *
 * @param {Connection} connection - Solana connection
 * @param {Keypair} keypair - Wallet keypair
 * @param {BN} amount - Amount of SOL to wrap (in lamports)
 * @param {boolean} isDryRun - Whether to simulate without executing
 * @param {Console} logger - Optional logger
 * @returns {Promise<string | undefined>} Transaction signature (if not dry run)
 */
export async function wrapSolToWsol(
  connection: Connection,
  keypair: Keypair,
  amount: BN,
  isDryRun?: boolean,
  logger?: Console,
): Promise<string | undefined> {
  logger = logger ?? console;

  const wsolAta = getAssociatedTokenAddressSync(NATIVE_MINT, keypair.publicKey, false, TOKEN_PROGRAM_ID);

  logger.log(`Wrapping ${amount.toString()} lamports (${amount.toNumber() / LAMPORTS_PER_SOL} SOL) to wSOL`);

  // Build transaction with all required instructions
  const transaction = new Transaction();

  // 1. Create wSOL ATA if it doesn't exist (idempotent - safe to call even if exists)
  transaction.add(
    createAssociatedTokenAccountIdempotentInstruction(
      keypair.publicKey, // payer
      wsolAta, // associated token account
      keypair.publicKey, // owner
      NATIVE_MINT, // mint (wSOL)
      TOKEN_PROGRAM_ID,
    ),
  );

  // 2. Transfer SOL to the wSOL ATA
  transaction.add(
    SystemProgram.transfer({
      fromPubkey: keypair.publicKey,
      toPubkey: wsolAta,
      lamports: BigInt(amount.toString()),
    }),
  );

  // 3. Sync native instruction to update the token account balance
  transaction.add(createSyncNativeInstruction(wsolAta, TOKEN_PROGRAM_ID));

  if (isDryRun) {
    logger.log(`[DRY RUN] Would wrap ${amount.toString()} lamports to wSOL`);
    return;
  }

  try {
    const signature = await sendAndConfirmTransaction(connection, transaction, [keypair], {
      commitment: 'confirmed',
    });

    logger.log(`Successfully wrapped SOL to wSOL. Signature: ${signature}`);
    return signature;
  } catch (error) {
    logger.error(`Failed to wrap SOL to wSOL: ${error}`);
    throw error;
  }
}

/**
 * Check wSOL balance and wrap more SOL if needed
 * Used for revenue-based pools that distribute wSOL rewards
 *
 * @param {Connection} connection - Solana connection
 * @param {Keypair} keypair - Wallet keypair
 * @param {BN} requiredAmount - Required wSOL amount (in lamports)
 * @param {BN} currentWsolBalance - Current wSOL balance
 * @param {BN} nativeSolBalance - Current native SOL balance
 * @param {boolean} isDryRun - Whether to simulate without executing
 * @param {Console} logger - Optional logger
 * @returns {Promise<boolean>} true if sufficient wSOL is available (or was wrapped successfully)
 */
export async function ensureWsolBalance(
  connection: Connection,
  keypair: Keypair,
  requiredAmount: BN,
  currentWsolBalance: BN,
  nativeSolBalance: BN,
  isDryRun?: boolean,
  logger?: Console,
): Promise<boolean> {
  logger = logger ?? console;

  // If we already have enough wSOL, no wrapping needed
  if (currentWsolBalance.gte(requiredAmount)) {
    logger.log(`Sufficient wSOL balance: ${currentWsolBalance.toString()} >= ${requiredAmount.toString()}`);
    return true;
  }

  // Calculate how much more wSOL we need
  const shortfall = requiredAmount.sub(currentWsolBalance);

  // Reserve some SOL for transaction fees (0.01 SOL = 10_000_000 lamports)
  const feeReserve = new BN(10_000_000);
  const availableForWrapping = nativeSolBalance.sub(feeReserve);

  if (availableForWrapping.lt(shortfall)) {
    logger.error(
      `Insufficient SOL to wrap. Need ${shortfall.toString()} lamports but only ${availableForWrapping.toString()} available after fee reserve`,
    );
    return false;
  }

  logger.log(
    `wSOL balance insufficient. Have ${currentWsolBalance.toString()}, need ${requiredAmount.toString()}. Wrapping ${shortfall.toString()} lamports...`,
  );

  try {
    await wrapSolToWsol(connection, keypair, shortfall, isDryRun, logger);
    return true;
  } catch (error) {
    logger.error(`Failed to wrap SOL: ${error}`);
    return false;
  }
}
