import { describe, it, expect, beforeEach } from "bun:test";
import { Pool } from "../src/pool";
import { VirtualPositionManager } from "../src/virtual_position_mgr";

/**
 * Test setup helper
 */
function createTestPool(): Pool {
  const pool = new Pool(0.003, 60, 3000n);
  pool.reserveA = 1000000n;
  pool.reserveB = 2000000n;
  pool.sqrtPriceX64 = 18446744073709551616n; // price ≈ 1
  pool.tickCurrent = 0;
  pool.liquidity = 1000000n;
  return pool;
}

function createTestPositionManager(pool: Pool): VirtualPositionManager {
  const positionManager = new VirtualPositionManager(pool);
  positionManager.setInitialBalances(100000n, 200000n);
  return positionManager;
}

describe("VirtualPositionManager", () => {
  let pool: Pool;
  let positionManager: VirtualPositionManager;

  beforeEach(() => {
    pool = createTestPool();
    positionManager = createTestPositionManager(pool);
  });

  describe("Basic Multi-Position Support", () => {
    it("should create multiple positions", () => {
      const positionData = [
        { tickLower: -100, tickUpper: 100, amountA: 10000n, amountB: 20000n },
        { tickLower: -200, tickUpper: 200, amountA: 15000n, amountB: 30000n },
        { tickLower: -50, tickUpper: 50, amountA: 5000n, amountB: 10000n },
      ];

      const positionIds = positionManager.createMultiplePositions(positionData);

      expect(positionIds).toHaveLength(3);

      const allPositions = positionManager.getAllPositions();
      expect(allPositions).toHaveLength(3);
    });

    it("should manage individual positions", () => {
      const positionId = positionManager.createPosition(
        -100,
        100,
        10000n,
        20000n
      );

      const position = positionManager.getPosition(positionId);
      expect(position).toBeDefined();
      expect(position?.tickLower).toBe(-100);
      expect(position?.tickUpper).toBe(100);
      expect(position?.amountA).toBe(10000n);
      expect(position?.amountB).toBe(20000n);
    });

    it("should remove positions", () => {
      const positionId = positionManager.createPosition(
        -100,
        100,
        10000n,
        20000n
      );

      expect(positionManager.getPosition(positionId)).toBeDefined();

      const removed = positionManager.removePosition(positionId);
      expect(removed).toBe(true);
      expect(positionManager.getPosition(positionId)).toBeUndefined();
    });
  });

  describe("Position Filtering and Querying", () => {
    beforeEach(() => {
      // Create test positions
      const positionData = [
        { tickLower: -100, tickUpper: 100, amountA: 10000n, amountB: 20000n },
        { tickLower: -200, tickUpper: 200, amountA: 15000n, amountB: 30000n },
        { tickLower: -50, tickUpper: 50, amountA: 5000n, amountB: 10000n },
        { tickLower: -300, tickUpper: -100, amountA: 20000n, amountB: 0n },
        { tickLower: 100, tickUpper: 300, amountA: 0n, amountB: 40000n },
      ];
      positionManager.createMultiplePositions(positionData);
    });

    it("should filter active and inactive positions", () => {
      const activePositions = positionManager.getActivePositions();
      const inactivePositions = positionManager.getInactivePositions();

      expect(activePositions.length + inactivePositions.length).toBe(5);
      expect(activePositions.length).toBeGreaterThan(0);
      expect(inactivePositions.length).toBeGreaterThan(0);
    });

    it("should filter positions by tick range", () => {
      const positionsInRange = positionManager.getPositionsInRange(-150, 150);
      expect(positionsInRange.length).toBeGreaterThan(0);

      // Verify all positions are within the range
      for (const position of positionsInRange) {
        expect(position.tickLower).toBeGreaterThanOrEqual(-150);
        expect(position.tickUpper).toBeLessThanOrEqual(150);
      }
    });

    it("should filter positions by minimum liquidity", () => {
      const positionsWithMinLiquidity =
        positionManager.getPositionsWithMinLiquidity(10000n);
      expect(positionsWithMinLiquidity.length).toBeGreaterThan(0);

      // Verify all positions meet the minimum liquidity requirement
      for (const position of positionsWithMinLiquidity) {
        expect(position.liquidity).toBeGreaterThanOrEqual(10000n);
      }
    });

    it("should filter positions by time range", () => {
      const now = Date.now();
      const positionsByTime = positionManager.getPositionsByTimeRange(
        now - 1000,
        now + 1000
      );
      expect(positionsByTime.length).toBe(5); // All positions should be within this range
    });
  });

  describe("Bulk Operations", () => {
    beforeEach(() => {
      const positionData = [
        { tickLower: -100, tickUpper: 100, amountA: 10000n, amountB: 20000n },
        { tickLower: -200, tickUpper: 200, amountA: 15000n, amountB: 30000n },
        { tickLower: -50, tickUpper: 50, amountA: 5000n, amountB: 10000n },
      ];
      positionManager.createMultiplePositions(positionData);
    });

    it("should update multiple positions", () => {
      const allPositions = positionManager.getAllPositions();
      const positionIds = allPositions.map((p) => p.id);

      const updates = [
        {
          positionId: positionIds[0]!,
          amountADelta: 1000n,
          amountBDelta: 2000n,
        },
        {
          positionId: positionIds[1]!,
          amountADelta: -500n,
          amountBDelta: -1000n,
        },
      ];

      const updateResult = positionManager.updateMultiplePositions(updates);
      expect(updateResult.success).toBe(true);
      expect(updateResult.failedIds).toHaveLength(0);
    });

    it("should collect fees from multiple positions", () => {
      const allPositions = positionManager.getAllPositions();
      const positionIds = allPositions.map((p) => p.id);

      const feeResult = positionManager.collectMultipleFees(positionIds);
      expect(feeResult.failedIds).toHaveLength(0);
      expect(feeResult.collectedFees.size).toBe(positionIds.length);
    });

    it("should remove multiple positions", () => {
      const allPositions = positionManager.getAllPositions();
      const positionIds = allPositions.map((p) => p.id);

      const removeResult = positionManager.removeMultiplePositions([
        positionIds[2]!,
      ]);
      expect(removeResult.success).toBe(true);
      expect(removeResult.removedIds).toHaveLength(1);
      expect(removeResult.failedIds).toHaveLength(0);

      // Verify position was actually removed
      expect(positionManager.getPosition(positionIds[2]!)).toBeUndefined();
    });
  });

  describe("Position Analytics", () => {
    beforeEach(() => {
      const positionData = [
        { tickLower: -100, tickUpper: 100, amountA: 10000n, amountB: 20000n },
        { tickLower: -200, tickUpper: 200, amountA: 15000n, amountB: 30000n },
        { tickLower: -50, tickUpper: 50, amountA: 5000n, amountB: 10000n },
      ];
      positionManager.createMultiplePositions(positionData);
    });

    it("should provide comprehensive analytics", () => {
      const analytics = positionManager.getPositionAnalytics();

      expect(analytics.totalPositions).toBe(3);
      expect(analytics.totalLiquidity).toBeGreaterThan(0n);
      expect(analytics.totalValue).toBeGreaterThan(0n);
      expect(analytics.averagePositionSize).toBeGreaterThan(0n);
      expect(analytics.liquidityDistribution.ranges.length).toBeGreaterThan(0);
    });

    it("should calculate performance metrics", () => {
      const performance = positionManager.getPositionPerformanceMetrics();

      expect(typeof performance.averageReturn).toBe("number");
      expect(typeof performance.totalReturn).toBe("number");
      expect(performance.positionsAboveWater).toBeGreaterThanOrEqual(0);
      expect(performance.positionsBelowWater).toBeGreaterThanOrEqual(0);
    });

    it("should calculate risk metrics", () => {
      const risk = positionManager.getPositionRiskMetrics();

      expect(risk.concentrationRisk).toBeGreaterThanOrEqual(0);
      expect(risk.concentrationRisk).toBeLessThanOrEqual(1);
      expect(risk.liquidityRisk).toBeGreaterThanOrEqual(0);
      expect(risk.liquidityRisk).toBeLessThanOrEqual(1);
      expect(risk.rangeRisk).toBeGreaterThanOrEqual(0);
      expect(risk.rangeRisk).toBeLessThanOrEqual(1);
      expect(risk.diversificationScore).toBeGreaterThanOrEqual(0);
      expect(risk.diversificationScore).toBeLessThanOrEqual(1);
    });

    it("should provide position summary", () => {
      const summary = positionManager.getPositionSummary();

      expect(summary.overview.totalPositions).toBe(3);
      expect(summary.overview.totalValue).toBeGreaterThan(0n);
      expect(summary.analytics).toBeDefined();
      expect(summary.performance).toBeDefined();
      expect(summary.risk).toBeDefined();
    });
  });

  describe("Position Sorting", () => {
    beforeEach(() => {
      const positionData = [
        { tickLower: -100, tickUpper: 100, amountA: 10000n, amountB: 20000n },
        { tickLower: -200, tickUpper: 200, amountA: 15000n, amountB: 30000n },
        { tickLower: -50, tickUpper: 50, amountA: 5000n, amountB: 10000n },
      ];
      positionManager.createMultiplePositions(positionData);
    });

    it("should sort positions by liquidity", () => {
      const sortedByLiquidity = positionManager.getPositionsSortedBy(
        "liquidity",
        false
      );

      expect(sortedByLiquidity).toHaveLength(3);

      // Verify descending order
      for (let i = 0; i < sortedByLiquidity.length - 1; i++) {
        expect(sortedByLiquidity[i]!.liquidity).toBeGreaterThanOrEqual(
          sortedByLiquidity[i + 1]!.liquidity
        );
      }
    });

    it("should sort positions by amountA", () => {
      const sortedByAmountA = positionManager.getPositionsSortedBy(
        "amountA",
        true
      );

      expect(sortedByAmountA).toHaveLength(3);

      // Verify ascending order
      for (let i = 0; i < sortedByAmountA.length - 1; i++) {
        expect(sortedByAmountA[i]!.amountA).toBeLessThanOrEqual(
          sortedByAmountA[i + 1]!.amountA
        );
      }
    });

    it("should sort positions by creation time", () => {
      const sortedByTime = positionManager.getPositionsSortedBy(
        "createdAt",
        true
      );

      expect(sortedByTime).toHaveLength(3);

      // Verify ascending order
      for (let i = 0; i < sortedByTime.length - 1; i++) {
        expect(sortedByTime[i]!.createdAt).toBeLessThanOrEqual(
          sortedByTime[i + 1]!.createdAt
        );
      }
    });
  });

  describe("Criteria-Based Filtering", () => {
    beforeEach(() => {
      const positionData = [
        { tickLower: -100, tickUpper: 100, amountA: 10000n, amountB: 20000n },
        { tickLower: -200, tickUpper: 200, amountA: 15000n, amountB: 30000n },
        { tickLower: -50, tickUpper: 50, amountA: 5000n, amountB: 10000n },
      ];
      positionManager.createMultiplePositions(positionData);
    });

    it("should filter by multiple criteria", () => {
      const criteriaResults = positionManager.getPositionsByCriteria({
        tickRange: { lower: -100, upper: 100 },
        minLiquidity: 10000n,
        activeOnly: true,
      });

      expect(criteriaResults.length).toBeGreaterThan(0);

      // Verify all results match criteria
      for (const position of criteriaResults) {
        expect(position.tickLower).toBeGreaterThanOrEqual(-100);
        expect(position.tickUpper).toBeLessThanOrEqual(100);
        expect(position.liquidity).toBeGreaterThanOrEqual(10000n);
      }
    });

    it("should filter by time range and minimum fees", () => {
      const now = Date.now();
      const criteriaResults = positionManager.getPositionsByCriteria({
        timeRange: { start: now - 1000, end: now + 1000 },
        minFees: { fee0: 0n, fee1: 0n },
      });

      expect(criteriaResults.length).toBe(3); // All positions should match
    });
  });

  describe("Position Management", () => {
    it("should update position amounts", () => {
      const positionId = positionManager.createPosition(
        -100,
        100,
        10000n,
        20000n
      );

      const success = positionManager.updatePosition(positionId, 1000n, 2000n);
      expect(success).toBe(true);

      const position = positionManager.getPosition(positionId);
      expect(position?.amountA).toBe(11000n);
      expect(position?.amountB).toBe(22000n);
    });

    it("should calculate position fees", () => {
      const positionId = positionManager.createPosition(
        -100,
        100,
        10000n,
        20000n
      );

      const fees = positionManager.calculatePositionFees(positionId);
      expect(fees.fee0).toBeGreaterThanOrEqual(0n);
      expect(fees.fee1).toBeGreaterThanOrEqual(0n);
    });

    it("should collect position fees", () => {
      const positionId = positionManager.createPosition(
        -100,
        100,
        10000n,
        20000n
      );

      const fees = positionManager.collectFees(positionId);
      expect(fees).toBeDefined();
      expect(fees?.fee0).toBeGreaterThanOrEqual(0n);
      expect(fees?.fee1).toBeGreaterThanOrEqual(0n);
    });

    it("should get position value", () => {
      const positionId = positionManager.createPosition(
        -100,
        100,
        10000n,
        20000n
      );

      const value = positionManager.getPositionValue(positionId);
      expect(value.totalValue).toBeGreaterThan(0n);
      expect(value.valueA).toBe(10000n);
      expect(value.valueB).toBe(20000n);
    });
  });

  describe("Totals and Summary", () => {
    beforeEach(() => {
      const positionData = [
        { tickLower: -100, tickUpper: 100, amountA: 10000n, amountB: 20000n },
        { tickLower: -200, tickUpper: 200, amountA: 15000n, amountB: 30000n },
      ];
      positionManager.createMultiplePositions(positionData);
    });

    it("should calculate totals", () => {
      const totals = positionManager.getTotals();

      expect(totals.positions).toBe(2);
      expect(totals.amountA).toBeGreaterThan(0n);
      expect(totals.amountB).toBeGreaterThan(0n);
      expect(totals.initialAmountA).toBe(100000n);
      expect(totals.initialAmountB).toBe(200000n);
      expect(totals.cashAmountA).toBe(100000n - 10000n - 15000n);
      expect(totals.cashAmountB).toBe(200000n - 20000n - 30000n);
    });

    it("should clear all positions", () => {
      expect(positionManager.getAllPositions()).toHaveLength(2);

      positionManager.clearAll();

      expect(positionManager.getAllPositions()).toHaveLength(0);
    });
  });

  describe("Open Position", () => {
    it("opens an in-range position using both tokens and updates cash", () => {
      const totalsBefore = positionManager.getTotals();
      expect(totalsBefore.cashAmountA).toBe(100000n);
      expect(totalsBefore.cashAmountB).toBe(200000n);

      const result = positionManager.openPosition(-100, 100, 10000n, 12000n);

      expect(result.liquidity).toBeGreaterThan(0n);
      expect(result.usedTokenA).toBeGreaterThan(0n);
      expect(result.usedTokenB).toBeGreaterThan(0n);
      expect(result.returnTokenA + result.usedTokenA).toBe(10000n);
      expect(result.returnTokenB + result.usedTokenB).toBe(12000n);

      const totalsAfter = positionManager.getTotals();
      expect(totalsAfter.cashAmountA).toBe(100000n - result.usedTokenA);
      expect(totalsAfter.cashAmountB).toBe(200000n - result.usedTokenB);
      expect(positionManager.getAllPositions()).toHaveLength(1);
    });

    it("opens an out-of-range position using single token", () => {
      // Move current tick above the range to force token B usage only
      pool.tickCurrent = 500;
      const result = positionManager.openPosition(-100, 0, 5000n, 7000n);

      expect(result.usedTokenA).toBe(0n);
      expect(result.usedTokenB).toBeGreaterThan(0n);
      expect(result.usedTokenB).toBeLessThanOrEqual(7000n);
      expect(result.returnTokenA).toBe(5000n);
      expect(result.returnTokenB).toBeLessThanOrEqual(1n);
    });

    it("throws when insufficient cash balance", () => {
      expect(() =>
        positionManager.openPosition(-100, 100, 200000n, 200000n)
      ).toThrow();
    });
  });

  describe("Fee accrual tracking", () => {
    it("updates fee totals when global fee growth increases", () => {
      const positionId = positionManager.createPosition(
        -100,
        100,
        10000n,
        20000n
      );

      const position = positionManager.getPosition(positionId)!;
      expect(position.tokensOwed0).toBe(0n);
      expect(position.tokensOwed1).toBe(0n);

      const baseGrowth0 = 1n << 64n;
      const baseGrowth1 = 2n << 64n;

      pool.feeGrowthGlobal0X64 = baseGrowth0;
      pool.feeGrowthGlobal1X64 = baseGrowth1;

      positionManager.updateAllPositionFees();

      let totals = positionManager.getTotals();
      expect(totals.feesOwed0).toBe(position.liquidity);
      expect(totals.feesOwed1).toBe(position.liquidity * 2n);

      pool.feeGrowthGlobal0X64 += baseGrowth0;
      pool.feeGrowthGlobal1X64 += baseGrowth0;

      positionManager.updateAllPositionFees();

      totals = positionManager.getTotals();
      expect(totals.feesOwed0).toBe(position.liquidity * 2n);
      expect(totals.feesOwed1).toBe(position.liquidity * 3n);
    });
  });

  describe("addLiquidityWithSwap", () => {
    it("swaps excess token B to maximise liquidity", () => {
      positionManager.setInitialBalances(100000n, 300000n);

      const simple = positionManager.openPosition(-10, 10, 50000n, 200000n);
      positionManager.removePosition(simple.positionId);

      positionManager.setInitialBalances(100000n, 300000n);

      const result = positionManager.addLiquidityWithSwap(
        -10,
        10,
        50000n,
        200000n,
        1000
      );

      expect(result.liquidity).toBeGreaterThan(simple.liquidity);
      expect(result.swappedFromTokenA + result.swappedFromTokenB).toBeGreaterThan(0n);
      expect(result.swappedToTokenA + result.swappedToTokenB).toBeGreaterThan(0n);
      expect(typeof result.slippageHit).toBe("boolean");
    });

    it("respects max slippage limit and avoids swaps when too strict", () => {
      positionManager.setInitialBalances(100000n, 150000n);

      const result = positionManager.addLiquidityWithSwap(
        -10,
        10,
        80000n,
        150000n,
        0
      );

      expect(result.swappedFromTokenA).toBe(0n);
      expect(result.swappedFromTokenB).toBe(0n);
      expect(result.slippageHit).toBe(true);
    });

    it("converts out-of-range token balances to required side", () => {
      pool.tickCurrent = -200;
      positionManager.setInitialBalances(0n, 50000n);

      const result = positionManager.addLiquidityWithSwap(
        -100,
        -50,
        0n,
        50000n,
        5000
      );

      expect(result.usedTokenA).toBeGreaterThan(0n);
      expect(result.swappedFromTokenB).toBeGreaterThan(0n);
      expect(result.swappedToTokenA).toBeGreaterThan(0n);
      expect(result.liquidity).toBeGreaterThan(0n);
    });
  });
});
