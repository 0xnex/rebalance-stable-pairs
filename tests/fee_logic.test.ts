import { describe, it, expect, beforeEach } from "bun:test";
import { Pool } from "../src/pool";
import { VirtualPositionManager } from "../src/virtual_position_mgr";

/**
 * Comprehensive test suite for VPM fee logic
 *
 * This tests the core fee accrual mechanism which follows Uniswap V3:
 * - Fee growth is tracked globally (feeGrowthGlobalX64)
 * - Each position tracks its fee growth snapshot (feeGrowthInside0LastX64)
 * - Fees owed = liquidity * (currentFeeGrowth - lastFeeGrowth) / 2^64
 */

function createTestPool(): Pool {
  const pool = new Pool(0.003, 60, 3000n);
  pool.reserveA = 1000000000n; // 1B tokens
  pool.reserveB = 2000000000n; // 2B tokens
  pool.sqrtPriceX64 = 18446744073709551616n; // price ≈ 1.0
  pool.tickCurrent = 0;
  pool.liquidity = 1000000000n;

  // Initialize global fee growth to 0
  pool.feeGrowthGlobal0X64 = 0n;
  pool.feeGrowthGlobal1X64 = 0n;

  return pool;
}

function createTestPositionManager(pool: Pool): VirtualPositionManager {
  const manager = new VirtualPositionManager(pool);
  manager.setInitialBalances(100000000n, 200000000n); // 100M, 200M
  return manager;
}

describe("VPM Fee Logic", () => {
  let pool: Pool;
  let manager: VirtualPositionManager;

  beforeEach(() => {
    pool = createTestPool();
    manager = createTestPositionManager(pool);
  });

  describe("Basic Fee Accrual", () => {
    it("should start with zero fees for new position", () => {
      const posId = manager.createPosition(-100, 100, 1000000n, 2000000n);
      const position = manager.getPosition(posId)!;

      expect(position.tokensOwed0).toBe(0n);
      expect(position.tokensOwed1).toBe(0n);

      const fees = manager.calculatePositionFees(posId);
      expect(fees.fee0).toBe(0n);
      expect(fees.fee1).toBe(0n);
    });

    it("should accrue fees when global fee growth increases", () => {
      const posId = manager.createPosition(-100, 100, 1000000n, 2000000n);
      const position = manager.getPosition(posId)!;

      // Simulate fee accumulation: 1 unit per liquidity
      const Q64 = 1n << 64n;
      pool.feeGrowthGlobal0X64 = Q64; // 1.0 in Q64 format
      pool.feeGrowthGlobal1X64 = Q64;

      const fees = manager.calculatePositionFees(posId);

      // Expected: liquidity * feeGrowthDelta / Q64 = liquidity * 1 * Q64 / Q64 = liquidity
      expect(fees.fee0).toBe(position.liquidity);
      expect(fees.fee1).toBe(position.liquidity);
    });

    it("should correctly scale fees with different fee growth rates", () => {
      const posId = manager.createPosition(-100, 100, 1000000n, 2000000n);
      const position = manager.getPosition(posId)!;

      const Q64 = 1n << 64n;
      // Token0 grows faster than token1
      pool.feeGrowthGlobal0X64 = Q64 * 3n; // 3x
      pool.feeGrowthGlobal1X64 = Q64 * 1n; // 1x

      const fees = manager.calculatePositionFees(posId);

      expect(fees.fee0).toBe(position.liquidity * 3n);
      expect(fees.fee1).toBe(position.liquidity * 1n);
    });

    it("should handle very small fee growth increments", () => {
      const posId = manager.createPosition(-100, 100, 10000000n, 20000000n);
      const position = manager.getPosition(posId)!;

      // Very small fee growth: 0.000001 units
      const Q64 = 1n << 64n;
      pool.feeGrowthGlobal0X64 = Q64 / 1000000n;
      pool.feeGrowthGlobal1X64 = Q64 / 1000000n;

      const fees = manager.calculatePositionFees(posId);

      // Fees should be proportional to liquidity
      const expectedFees = position.liquidity / 1000000n;
      expect(fees.fee0).toBe(expectedFees);
      expect(fees.fee1).toBe(expectedFees);
    });
  });

  describe("Fee Updates and Collection", () => {
    it("should update position fees and reset growth baseline", () => {
      const posId = manager.createPosition(-100, 100, 1000000n, 2000000n);

      const Q64 = 1n << 64n;
      pool.feeGrowthGlobal0X64 = Q64;
      pool.feeGrowthGlobal1X64 = Q64;

      // First update
      manager.updatePositionFees(posId);

      const position = manager.getPosition(posId)!;
      const expectedFees = position.liquidity;

      expect(position.tokensOwed0).toBe(expectedFees);
      expect(position.tokensOwed1).toBe(expectedFees);

      // Fee growth baseline should be updated
      expect(position.feeGrowthInside0LastX64).toBe(Q64);
      expect(position.feeGrowthInside1LastX64).toBe(Q64);

      // Second update with more fee growth
      pool.feeGrowthGlobal0X64 = Q64 * 2n;
      pool.feeGrowthGlobal1X64 = Q64 * 2n;

      manager.updatePositionFees(posId);

      // Should have accumulated additional fees
      const position2 = manager.getPosition(posId)!;
      expect(position2.tokensOwed0).toBe(expectedFees * 2n);
      expect(position2.tokensOwed1).toBe(expectedFees * 2n);
    });

    it("should collect fees and reset tokensOwed", () => {
      const posId = manager.createPosition(-100, 100, 1000000n, 2000000n);

      const Q64 = 1n << 64n;
      pool.feeGrowthGlobal0X64 = Q64;
      pool.feeGrowthGlobal1X64 = Q64;

      manager.updatePositionFees(posId);

      const cashBefore = manager.getTotals();
      const collectedFees = manager.collectFees(posId);
      const cashAfter = manager.getTotals();

      expect(collectedFees).not.toBeNull();
      expect(collectedFees!.fee0).toBeGreaterThan(0n);
      expect(collectedFees!.fee1).toBeGreaterThan(0n);

      // Cash balances should increase by collected fees
      expect(cashAfter.cashAmountA).toBe(
        cashBefore.cashAmountA + collectedFees!.fee0
      );
      expect(cashAfter.cashAmountB).toBe(
        cashBefore.cashAmountB + collectedFees!.fee1
      );

      // Position should have zero tokens owed after collection
      const position = manager.getPosition(posId)!;
      expect(position.tokensOwed0).toBe(0n);
      expect(position.tokensOwed1).toBe(0n);
    });

    it("should track total collected fees across all positions", () => {
      const pos1 = manager.createPosition(-100, 100, 1000000n, 2000000n);
      const pos2 = manager.createPosition(-200, 200, 2000000n, 4000000n);

      const Q64 = 1n << 64n;
      pool.feeGrowthGlobal0X64 = Q64;
      pool.feeGrowthGlobal1X64 = Q64;

      manager.updateAllPositionFees();

      const fees1 = manager.collectFees(pos1);
      const fees2 = manager.collectFees(pos2);

      const totals = manager.getTotals();

      expect(totals.collectedFees0).toBe(fees1!.fee0 + fees2!.fee0);
      expect(totals.collectedFees1).toBe(fees1!.fee1 + fees2!.fee1);
    });
  });

  describe("Multiple Positions with Different Liquidity", () => {
    it("should accrue fees proportional to liquidity", () => {
      // Create two positions with 1:2 liquidity ratio
      const smallPos = manager.createPosition(-100, 100, 1000000n, 2000000n);
      const largePos = manager.createPosition(-100, 100, 2000000n, 4000000n);

      const smallPosData = manager.getPosition(smallPos)!;
      const largePosData = manager.getPosition(largePos)!;

      // Large position should have roughly 2x liquidity
      const liquidityRatio =
        Number(largePosData.liquidity) / Number(smallPosData.liquidity);
      expect(liquidityRatio).toBeGreaterThan(1.5);
      expect(liquidityRatio).toBeLessThan(2.5);

      const Q64 = 1n << 64n;
      pool.feeGrowthGlobal0X64 = Q64;
      pool.feeGrowthGlobal1X64 = Q64;

      const feesSmall = manager.calculatePositionFees(smallPos);
      const feesLarge = manager.calculatePositionFees(largePos);

      // Fees should be proportional to liquidity
      expect(feesLarge.fee0).toBe(largePosData.liquidity);
      expect(feesLarge.fee1).toBe(largePosData.liquidity);
      expect(feesSmall.fee0).toBe(smallPosData.liquidity);
      expect(feesSmall.fee1).toBe(smallPosData.liquidity);

      // Ratio of fees should match ratio of liquidity
      const feeRatio = Number(feesLarge.fee0) / Number(feesSmall.fee0);
      expect(Math.abs(feeRatio - liquidityRatio)).toBeLessThan(0.1);
    });

    it("should handle positions created at different times", () => {
      const Q64 = 1n << 64n;

      // Create first position
      const pos1 = manager.createPosition(-100, 100, 1000000n, 2000000n);

      // Some fees accrue
      pool.feeGrowthGlobal0X64 = Q64;
      pool.feeGrowthGlobal1X64 = Q64;

      // Create second position (should start with current fee growth as baseline)
      const pos2 = manager.createPosition(-100, 100, 1000000n, 2000000n);

      const fees1 = manager.calculatePositionFees(pos1);
      const fees2 = manager.calculatePositionFees(pos2);

      // pos1 should have accumulated fees, pos2 should have none
      expect(fees1.fee0).toBeGreaterThan(0n);
      expect(fees1.fee1).toBeGreaterThan(0n);
      expect(fees2.fee0).toBe(0n);
      expect(fees2.fee1).toBe(0n);

      // More fees accrue
      pool.feeGrowthGlobal0X64 = Q64 * 2n;
      pool.feeGrowthGlobal1X64 = Q64 * 2n;

      const fees1After = manager.calculatePositionFees(pos1);
      const fees2After = manager.calculatePositionFees(pos2);

      // Now both should have accumulated more fees
      expect(fees1After.fee0).toBeGreaterThan(fees1.fee0);
      expect(fees2After.fee0).toBeGreaterThan(fees2.fee0);
    });
  });

  describe("Fee Accrual with Position State Changes", () => {
    it("should preserve fees when removing position", () => {
      const posId = manager.createPosition(-100, 100, 1000000n, 2000000n);

      const Q64 = 1n << 64n;
      pool.feeGrowthGlobal0X64 = Q64;
      pool.feeGrowthGlobal1X64 = Q64;

      const feesBefore = manager.calculatePositionFees(posId);
      const cashBefore = manager.getTotals();

      // Remove position (should collect fees automatically)
      manager.removePosition(posId);

      const cashAfter = manager.getTotals();

      // Cash should increase by principal + fees
      expect(cashAfter.collectedFees0).toBe(feesBefore.fee0);
      expect(cashAfter.collectedFees1).toBe(feesBefore.fee1);
    });

    it("should handle updateAllPositionFees correctly", () => {
      const pos1 = manager.createPosition(-100, 100, 1000000n, 2000000n);
      const pos2 = manager.createPosition(-200, 200, 2000000n, 4000000n);
      const pos3 = manager.createPosition(-50, 50, 500000n, 1000000n);

      const Q64 = 1n << 64n;
      pool.feeGrowthGlobal0X64 = Q64;
      pool.feeGrowthGlobal1X64 = Q64;

      manager.updateAllPositionFees();

      // All positions should have updated fees
      const totals = manager.getTotals();
      expect(totals.feesOwed0).toBeGreaterThan(0n);
      expect(totals.feesOwed1).toBeGreaterThan(0n);

      // Individual position checks
      const p1 = manager.getPosition(pos1)!;
      const p2 = manager.getPosition(pos2)!;
      const p3 = manager.getPosition(pos3)!;

      expect(p1.tokensOwed0).toBeGreaterThan(0n);
      expect(p2.tokensOwed0).toBeGreaterThan(0n);
      expect(p3.tokensOwed0).toBeGreaterThan(0n);

      // Sum should match totals
      const sumOwed0 = p1.tokensOwed0 + p2.tokensOwed0 + p3.tokensOwed0;
      const sumOwed1 = p1.tokensOwed1 + p2.tokensOwed1 + p3.tokensOwed1;

      expect(sumOwed0).toBe(totals.feesOwed0);
      expect(sumOwed1).toBe(totals.feesOwed1);
    });
  });

  describe("Fee Formula Correctness", () => {
    it("should follow Uniswap V3 fee calculation formula", () => {
      const posId = manager.createPosition(-100, 100, 1000000n, 2000000n);
      const position = manager.getPosition(posId)!;

      // Test various fee growth values
      const Q64 = 1n << 64n;
      const testCases = [
        { growth: Q64 / 100n, description: "0.01x" },
        { growth: Q64 / 10n, description: "0.1x" },
        { growth: Q64, description: "1x" },
        { growth: Q64 * 5n, description: "5x" },
        { growth: Q64 * 100n, description: "100x" },
      ];

      for (const testCase of testCases) {
        pool.feeGrowthGlobal0X64 = testCase.growth;
        pool.feeGrowthGlobal1X64 = testCase.growth;

        const fees = manager.calculatePositionFees(posId);

        // Manual calculation: fees = liquidity * feeGrowthDelta / Q64
        const feeGrowthDelta = testCase.growth - 0n; // baseline is 0
        const expectedFees = (position.liquidity * feeGrowthDelta) / Q64;

        expect(fees.fee0).toBe(expectedFees);
        expect(fees.fee1).toBe(expectedFees);
      }
    });

    it("should handle fee growth overflow correctly", () => {
      const posId = manager.createPosition(-100, 100, 1000000n, 2000000n);

      // Set extremely large fee growth
      const Q64 = 1n << 64n;
      pool.feeGrowthGlobal0X64 = Q64 * 1000000n; // 1M x
      pool.feeGrowthGlobal1X64 = Q64 * 1000000n;

      // Should not throw
      const fees = manager.calculatePositionFees(posId);
      expect(fees.fee0).toBeGreaterThan(0n);
      expect(fees.fee1).toBeGreaterThan(0n);
    });

    it("should handle fee growth not increasing", () => {
      const posId = manager.createPosition(-100, 100, 1000000n, 2000000n);

      const Q64 = 1n << 64n;
      pool.feeGrowthGlobal0X64 = Q64;
      manager.updatePositionFees(posId);

      // Fee growth stays the same
      const fees1 = manager.calculatePositionFees(posId);

      // Should have only the existing tokensOwed, no new fees
      const position = manager.getPosition(posId)!;
      expect(fees1.fee0).toBe(position.tokensOwed0);
      expect(fees1.fee1).toBe(position.tokensOwed1);

      // If we set growth to same value and update again, no new fees accrue
      manager.updatePositionFees(posId);
      const fees2 = manager.calculatePositionFees(posId);
      expect(fees2.fee0).toBe(fees1.fee0);
      expect(fees2.fee1).toBe(fees1.fee1);
    });
  });

  describe("Edge Cases", () => {
    it("should handle zero liquidity position", () => {
      // Create position with very small amounts
      const posId = manager.createPosition(-100, 100, 1n, 1n);
      const position = manager.getPosition(posId)!;

      const Q64 = 1n << 64n;
      pool.feeGrowthGlobal0X64 = Q64 * 1000n;
      pool.feeGrowthGlobal1X64 = Q64 * 1000n;

      const fees = manager.calculatePositionFees(posId);

      // Fees should scale with tiny liquidity
      expect(fees.fee0).toBe(position.liquidity * 1000n);
      expect(fees.fee1).toBe(position.liquidity * 1000n);
    });

    it("should handle position out of range", () => {
      // Create position below current price
      pool.tickCurrent = 500;
      const posId = manager.createPosition(-100, 0, 0n, 1000000n);

      const Q64 = 1n << 64n;
      pool.feeGrowthGlobal0X64 = Q64;
      pool.feeGrowthGlobal1X64 = Q64;

      // Out of range positions don't accrue fees in the same way
      // But VPM still tracks them
      const fees = manager.calculatePositionFees(posId);
      expect(fees.fee0).toBeGreaterThanOrEqual(0n);
      expect(fees.fee1).toBeGreaterThanOrEqual(0n);
    });

    it("should handle rapid fee updates", () => {
      const posId = manager.createPosition(-100, 100, 1000000n, 2000000n);

      const Q64 = 1n << 64n;
      let totalExpectedFees = 0n;

      // Simulate 100 small fee accruals
      for (let i = 1; i <= 100; i++) {
        pool.feeGrowthGlobal0X64 = Q64 * BigInt(i);
        pool.feeGrowthGlobal1X64 = Q64 * BigInt(i);
        manager.updatePositionFees(posId);
      }

      const position = manager.getPosition(posId)!;

      // Should have accumulated all fees
      expect(position.tokensOwed0).toBeGreaterThan(0n);
      expect(position.tokensOwed1).toBeGreaterThan(0n);
    });

    it("should maintain fee accounting invariant", () => {
      // Create multiple positions
      const positions = [
        manager.createPosition(-100, 100, 1000000n, 2000000n),
        manager.createPosition(-200, 200, 2000000n, 4000000n),
        manager.createPosition(-50, 50, 500000n, 1000000n),
      ];

      const Q64 = 1n << 64n;
      pool.feeGrowthGlobal0X64 = Q64 * 10n;
      pool.feeGrowthGlobal1X64 = Q64 * 10n;

      manager.updateAllPositionFees();

      // Collect fees from all positions
      let totalCollected0 = 0n;
      let totalCollected1 = 0n;

      for (const posId of positions) {
        const fees = manager.collectFees(posId);
        if (fees) {
          totalCollected0 += fees.fee0;
          totalCollected1 += fees.fee1;
        }
      }

      const totals = manager.getTotals();

      // Total collected should match recorded total
      expect(totals.collectedFees0).toBe(totalCollected0);
      expect(totals.collectedFees1).toBe(totalCollected1);

      // All positions should have zero owed after collection
      expect(totals.feesOwed0).toBe(0n);
      expect(totals.feesOwed1).toBe(0n);
    });
  });

  describe("Performance and Stress Tests", () => {
    it("should handle many positions efficiently", () => {
      const numPositions = 100;
      const positions: string[] = [];

      // Create many positions
      for (let i = 0; i < numPositions; i++) {
        const tickLower = -1000 + i * 10;
        const tickUpper = tickLower + 100;
        const posId = manager.createPosition(
          tickLower,
          tickUpper,
          10000n,
          20000n
        );
        positions.push(posId);
      }

      const Q64 = 1n << 64n;
      pool.feeGrowthGlobal0X64 = Q64;
      pool.feeGrowthGlobal1X64 = Q64;

      // Update all positions
      const startTime = performance.now();
      manager.updateAllPositionFees();
      const endTime = performance.now();

      // Should complete in reasonable time (< 100ms)
      expect(endTime - startTime).toBeLessThan(100);

      // Verify totals
      const totals = manager.getTotals();
      expect(totals.positions).toBe(numPositions);
      expect(totals.feesOwed0).toBeGreaterThan(0n);
      expect(totals.feesOwed1).toBeGreaterThan(0n);
    });

    it("should handle extreme liquidity values", () => {
      // Create position with large liquidity (within balance limits)
      const posId = manager.createPosition(
        -100,
        100,
        50000000n, // 50M
        100000000n // 100M
      );

      const position = manager.getPosition(posId)!;

      const Q64 = 1n << 64n;
      pool.feeGrowthGlobal0X64 = Q64;
      pool.feeGrowthGlobal1X64 = Q64;

      const fees = manager.calculatePositionFees(posId);

      // Should handle large numbers correctly
      expect(fees.fee0).toBe(position.liquidity);
      expect(fees.fee1).toBe(position.liquidity);
      expect(position.liquidity).toBeGreaterThan(50000000n);
    });
  });
});
