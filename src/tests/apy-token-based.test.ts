import BN from 'bn.js';
import assert from 'node:assert';
import { describe, test } from 'node:test';
import { calculateIntervalReward, calculateTokensNeededForTargetAPY } from '../lib/apy-token-based.js';
import type { StakingPool } from '../lib/types.js';

describe('apy-token-based.ts', () => {
  describe('calculateIntervalReward', () => {
    test('should calculate correct interval reward for basic inputs', () => {
      const totalStaked = new BN(1000000); // 1M tokens (assuming 6 decimals)
      const annualRate = new BN(8); // 8% APY
      const intervalMinutes = 60; // 1 hour

      const result = calculateIntervalReward(totalStaked, annualRate, intervalMinutes);

      // Expected: 1,000,000 * 8% * (60 / 525600) = 1,000,000 * 0.08 * 0.000114155
      // = 9.132 tokens approximately
      // With precision decimals (6), this should be around 9 tokens
      assert(result.gt(new BN(0)), 'Result should be greater than 0');
      assert(result.lt(new BN(100)), 'Result should be reasonable for 1 hour interval');
    });

    test('should calculate correct interval reward for daily interval', () => {
      const totalStaked = new BN(1000000); // 1M tokens
      const annualRate = new BN(12); // 12% APY
      const intervalMinutes = 1440; // 24 hours = 1 day

      const result = calculateIntervalReward(totalStaked, annualRate, intervalMinutes);

      // Expected: 1,000,000 * 12% * (1440 / 525600) = 1,000,000 * 0.12 * 0.002739726
      // = 328.767 tokens approximately
      assert(result.gt(new BN(300)), 'Result should be around 300+ tokens for daily interval');
      assert(result.lt(new BN(400)), 'Result should be reasonable for daily interval');
    });

    test('should calculate correct interval reward for weekly interval', () => {
      const totalStaked = new BN(500000); // 500K tokens
      const annualRate = new BN(15); // 15% APY
      const intervalMinutes = 10080; // 7 days

      const result = calculateIntervalReward(totalStaked, annualRate, intervalMinutes);

      // Expected: 500,000 * 15% * (10080 / 525600) = 500,000 * 0.15 * 0.019178082
      // = 1,438.356 tokens approximately
      assert(result.gt(new BN(1400)), 'Result should be around 1400+ tokens for weekly interval');
      assert(result.lt(new BN(1500)), 'Result should be reasonable for weekly interval');
    });

    test('should return zero for zero total staked', () => {
      const totalStaked = new BN(0);
      const annualRate = new BN(8);
      const intervalMinutes = 60;

      const result = calculateIntervalReward(totalStaked, annualRate, intervalMinutes);

      assert.equal(result.toString(), '0', 'Should return 0 for zero staked amount');
    });

    test('should return zero for negative total staked', () => {
      const totalStaked = new BN(-1000);
      const annualRate = new BN(8);
      const intervalMinutes = 60;

      const result = calculateIntervalReward(totalStaked, annualRate, intervalMinutes);

      assert.equal(result.toString(), '0', 'Should return 0 for negative staked amount');
    });

    test('should return zero for zero annual rate', () => {
      const totalStaked = new BN(1000000);
      const annualRate = new BN(0);
      const intervalMinutes = 60;

      const result = calculateIntervalReward(totalStaked, annualRate, intervalMinutes);

      assert.equal(result.toString(), '0', 'Should return 0 for zero annual rate');
    });

    test('should return zero for zero interval minutes', () => {
      const totalStaked = new BN(1000000);
      const annualRate = new BN(8);
      const intervalMinutes = 0;

      const result = calculateIntervalReward(totalStaked, annualRate, intervalMinutes);

      assert.equal(result.toString(), '0', 'Should return 0 for zero interval minutes');
    });

    test('should handle small amounts correctly', () => {
      const totalStaked = new BN(100); // Very small amount
      const annualRate = new BN(5);
      const intervalMinutes = 60;

      const result = calculateIntervalReward(totalStaked, annualRate, intervalMinutes);

      // Should handle small calculations without throwing
      assert(result.gte(new BN(0)), 'Result should be non-negative');
    });

    test('should handle large amounts correctly', () => {
      const totalStaked = new BN('1000000000000'); // Very large amount
      const annualRate = new BN(10);
      const intervalMinutes = 1440;

      const result = calculateIntervalReward(totalStaked, annualRate, intervalMinutes);

      assert(result.gt(new BN(0)), 'Result should be greater than 0 for large amounts');
    });
  });

  describe('calculateTokensNeededForTargetAPYV2', () => {
    // Helper function to create a mock staking pool
    const createMockStakingPool = (tvl: BN, numRewardPools: number = 1): StakingPool => ({
      tvl,
      mint: 'mockMintAddress',
      decimals: 6,
      rewardPools: Array.from({ length: numRewardPools }, (_, i) => ({
        address: `mockPoolAddress${i}`,
        mint: 'mockMintAddress',
        vault: `mockVaultAddress${i}`,
        fundedAmount: new BN(0),
        claimedAmount: new BN(0),
        rewardsState: new BN(0),
        lastAmount: new BN(0),
        createdTs: new BN(Date.now()),
        decimals: 6,
      })),
    });

    describe('proportional distribution strategy', () => {
      test('should calculate tokens needed for single reward pool', () => {
        const stakingPool = createMockStakingPool(new BN(1000000), 1);
        const fundingFrequencyMinutes = 60;
        const targetAPY = 8;

        const result = calculateTokensNeededForTargetAPY(
          stakingPool,
          fundingFrequencyMinutes,
          targetAPY,
          'proportional',
        );

        assert.equal(result.tokensNeededPerPool.length, 1, 'Should have tokens for 1 pool');
        assert(result.totalTokensNeeded.gt(new BN(0)), 'Total tokens needed should be greater than 0');
        assert.equal(
          result.totalTokensNeeded.toString(),
          result.tokensNeededPerPool[0]!.tokensNeeded.toString(),
          'Total should equal single pool amount',
        );
        assert.equal(result.tokensNeededPerPool[0]!.poolAddress, 'mockPoolAddress0');
        assert.equal(result.tokensNeededPerPool[0]!.mint, 'mockMintAddress');
      });

      test('should calculate tokens needed for multiple reward pools', () => {
        const stakingPool = createMockStakingPool(new BN(2000000), 3);
        const fundingFrequencyMinutes = 1440; // Daily
        const targetAPY = 12;

        const result = calculateTokensNeededForTargetAPY(
          stakingPool,
          fundingFrequencyMinutes,
          targetAPY,
          'proportional',
        );

        assert.equal(result.tokensNeededPerPool.length, 3, 'Should have tokens for 3 pools');
        assert(result.totalTokensNeeded.gt(new BN(0)), 'Total tokens needed should be greater than 0');

        // Each pool should have the same amount since they use the same TVL
        const firstPoolAmount = result.tokensNeededPerPool[0]!.tokensNeeded;
        for (const pool of result.tokensNeededPerPool) {
          assert.equal(
            pool.tokensNeeded.toString(),
            firstPoolAmount.toString(),
            'All pools should have the same token amount in proportional strategy',
          );
        }

        // Total should be 3x the individual pool amount
        const expectedTotal = firstPoolAmount.mul(new BN(3));
        assert.equal(
          result.totalTokensNeeded.toString(),
          expectedTotal.toString(),
          'Total should be sum of all pool amounts',
        );
      });

      test('should handle zero TVL', () => {
        const stakingPool = createMockStakingPool(new BN(0), 1);
        const fundingFrequencyMinutes = 60;
        const targetAPY = 8;

        const result = calculateTokensNeededForTargetAPY(
          stakingPool,
          fundingFrequencyMinutes,
          targetAPY,
          'proportional',
        );

        assert.equal(result.totalTokensNeeded.toString(), '0', 'Should return 0 for zero TVL');
        assert.equal(result.tokensNeededPerPool[0]!.tokensNeeded.toString(), '0', 'Pool amount should be 0');
      });
    });

    describe('single_pool distribution strategy', () => {
      test('should calculate tokens needed for specified pool index', () => {
        const stakingPool = createMockStakingPool(new BN(1500000), 3);
        const fundingFrequencyMinutes = 120; // 2 hours
        const targetAPY = 10;
        const targetPoolIndex = 1; // Second pool

        const result = calculateTokensNeededForTargetAPY(
          stakingPool,
          fundingFrequencyMinutes,
          targetAPY,
          'single_pool',
          targetPoolIndex,
        );

        assert.equal(result.tokensNeededPerPool.length, 1, 'Should have tokens for 1 pool only');
        assert(result.totalTokensNeeded.gt(new BN(0)), 'Total tokens needed should be greater than 0');
        assert.equal(
          result.totalTokensNeeded.toString(),
          result.tokensNeededPerPool[0]!.tokensNeeded.toString(),
          'Total should equal single pool amount',
        );
        assert.equal(result.tokensNeededPerPool[0]!.poolAddress, 'mockPoolAddress1');
        assert.equal(result.tokensNeededPerPool[0]!.mint, 'mockMintAddress');
      });

      test('should calculate tokens for first pool (index 0)', () => {
        const stakingPool = createMockStakingPool(new BN(1000000), 2);
        const fundingFrequencyMinutes = 60;
        const targetAPY = 5;
        const targetPoolIndex = 0;

        const result = calculateTokensNeededForTargetAPY(
          stakingPool,
          fundingFrequencyMinutes,
          targetAPY,
          'single_pool',
          targetPoolIndex,
        );

        assert.equal(result.tokensNeededPerPool.length, 1, 'Should have tokens for 1 pool only');
        assert.equal(result.tokensNeededPerPool[0]!.poolAddress, 'mockPoolAddress0');
      });

      test('should calculate tokens for last pool', () => {
        const stakingPool = createMockStakingPool(new BN(1000000), 4);
        const fundingFrequencyMinutes = 60;
        const targetAPY = 5;
        const targetPoolIndex = 3; // Last pool

        const result = calculateTokensNeededForTargetAPY(
          stakingPool,
          fundingFrequencyMinutes,
          targetAPY,
          'single_pool',
          targetPoolIndex,
        );

        assert.equal(result.tokensNeededPerPool.length, 1, 'Should have tokens for 1 pool only');
        assert.equal(result.tokensNeededPerPool[0]!.poolAddress, 'mockPoolAddress3');
      });

      test('should throw error when targetPoolIndex is undefined', () => {
        const stakingPool = createMockStakingPool(new BN(1000000), 2);
        const fundingFrequencyMinutes = 60;
        const targetAPY = 8;

        assert.throws(
          () =>
            calculateTokensNeededForTargetAPY(
              stakingPool,
              fundingFrequencyMinutes,
              targetAPY,
              'single_pool',
              // targetPoolIndex is undefined
            ),
          /targetPoolIndex must be specified and valid for single_pool strategy/,
          'Should throw error when targetPoolIndex is undefined',
        );
      });

      test('should throw error when targetPoolIndex is negative', () => {
        const stakingPool = createMockStakingPool(new BN(1000000), 2);
        const fundingFrequencyMinutes = 60;
        const targetAPY = 8;
        const targetPoolIndex = -1;

        assert.throws(
          () =>
            calculateTokensNeededForTargetAPY(
              stakingPool,
              fundingFrequencyMinutes,
              targetAPY,
              'single_pool',
              targetPoolIndex,
            ),
          /targetPoolIndex must be specified and valid for single_pool strategy/,
          'Should throw error when targetPoolIndex is negative',
        );
      });

      test('should throw error when targetPoolIndex is out of bounds', () => {
        const stakingPool = createMockStakingPool(new BN(1000000), 2);
        const fundingFrequencyMinutes = 60;
        const targetAPY = 8;
        const targetPoolIndex = 5; // Out of bounds (only 2 pools exist)

        assert.throws(
          () =>
            calculateTokensNeededForTargetAPY(
              stakingPool,
              fundingFrequencyMinutes,
              targetAPY,
              'single_pool',
              targetPoolIndex,
            ),
          /targetPoolIndex must be specified and valid for single_pool strategy/,
          'Should throw error when targetPoolIndex is out of bounds',
        );
      });

      test('should throw error when targetPoolIndex equals pool length', () => {
        const stakingPool = createMockStakingPool(new BN(1000000), 2);
        const fundingFrequencyMinutes = 60;
        const targetAPY = 8;
        const targetPoolIndex = 2; // Equal to length (out of bounds)

        assert.throws(
          () =>
            calculateTokensNeededForTargetAPY(
              stakingPool,
              fundingFrequencyMinutes,
              targetAPY,
              'single_pool',
              targetPoolIndex,
            ),
          /targetPoolIndex must be specified and valid for single_pool strategy/,
          'Should throw error when targetPoolIndex equals pool length',
        );
      });
    });

    describe('edge cases and validation', () => {
      test('should handle empty reward pools array', () => {
        const stakingPool: StakingPool = {
          tvl: new BN(1000000),
          mint: 'mockMintAddress',
          decimals: 6,
          rewardPools: [], // Empty array
        };
        const fundingFrequencyMinutes = 60;
        const targetAPY = 8;

        const result = calculateTokensNeededForTargetAPY(
          stakingPool,
          fundingFrequencyMinutes,
          targetAPY,
          'proportional',
        );

        assert.equal(result.tokensNeededPerPool.length, 0, 'Should have no pools');
        assert.equal(result.totalTokensNeeded.toString(), '0', 'Total should be 0');
      });

      test('should use proportional as default distribution strategy', () => {
        const stakingPool = createMockStakingPool(new BN(1000000), 2);
        const fundingFrequencyMinutes = 60;
        const targetAPY = 8;

        const result = calculateTokensNeededForTargetAPY(
          stakingPool,
          fundingFrequencyMinutes,
          targetAPY,
          // No distribution strategy specified - should default to proportional
        );

        assert.equal(result.tokensNeededPerPool.length, 2, 'Should calculate for all pools (proportional default)');
      });

      test('should handle very small funding frequency', () => {
        const stakingPool = createMockStakingPool(new BN(1000000), 1);
        const fundingFrequencyMinutes = 1; // 1 minute
        const targetAPY = 8;

        const result = calculateTokensNeededForTargetAPY(
          stakingPool,
          fundingFrequencyMinutes,
          targetAPY,
          'proportional',
        );

        assert(result.totalTokensNeeded.gte(new BN(0)), 'Should handle small funding frequency');
        // Very small intervals should result in very small rewards
        assert(result.totalTokensNeeded.lt(new BN(10)), 'Should be small amount for 1-minute interval');
      });

      test('should handle large funding frequency', () => {
        const stakingPool = createMockStakingPool(new BN(1000000), 1);
        const fundingFrequencyMinutes = 525600; // 1 year
        const targetAPY = 8;

        const result = calculateTokensNeededForTargetAPY(
          stakingPool,
          fundingFrequencyMinutes,
          targetAPY,
          'proportional',
        );

        assert(result.totalTokensNeeded.gt(new BN(70000)), 'Should be large amount for yearly interval');
        // Should be approximately 8% of TVL for yearly interval
        assert(result.totalTokensNeeded.lt(new BN(90000)), 'Should be reasonable amount for yearly interval');
      });
    });
  });
});
