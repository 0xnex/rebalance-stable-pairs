import { describe, it, expect, beforeEach } from "bun:test";
import { PositionManager } from "../src/position_mgr";
import { SimplePool } from "../src/simple_pool";
import { FixedSlippageProvider } from "../src/slippage_estimator";

describe("Performance Tracking", () => {
  let pool: SimplePool;
  let manager: PositionManager;
  const initialAmount0 = 1000000n;
  const initialAmount1 = 1000000n;

  beforeEach(() => {
    // Create a pool at price = 1.0 (1:1 ratio)
    pool = new SimplePool(
      "TOKEN0", // token0
      "TOKEN1", // token1
      6, // decimals0
      6, // decimals1
      3000, // feeTier (0.3%)
      10, // tickSpacing
      new FixedSlippageProvider(0.001) // 0.1% slippage
    );

    // Initialize pool at tick 0 (price = 1.0)
    const sqrtPriceX64 = BigInt(Math.floor(Math.sqrt(1.0) * Number(1n << 64n)));

    pool.onSwapEvent({
      timestamp: Date.now(),
      poolId: "test-pool",
      amountIn: 0n,
      amountOut: 0n,
      zeroForOne: true,
      sqrtPriceBefore: 0n,
      sqrtPriceAfter: sqrtPriceX64,
      feeAmount: 0n,
      liquidity: 1000000n,
      tick: 0,
      reserveA: 1000000n,
      reserveB: 1000000n,
    });

    manager = new PositionManager(initialAmount0, initialAmount1, pool);
  });

  // Helper to get sqrt price
  const getSqrtPriceX64 = () => BigInt(Math.floor(Math.sqrt(1.0) * Number(1n << 64n)));

  describe("Fund Performance", () => {
    it("should calculate initial fund performance with no positions", () => {
      const perf = manager.getFundPerformance();

      expect(perf.initialAmount0).toBe(initialAmount0);
      expect(perf.initialAmount1).toBe(initialAmount1);
      expect(perf.currentBalance0).toBe(initialAmount0);
      expect(perf.currentBalance1).toBe(initialAmount1);
      expect(perf.totalPositionValue).toBe(0n);
      expect(perf.totalFeeEarned).toBe(0n);
      expect(perf.pnl).toBe(0n);
      expect(perf.roiPercent).toBe(0);
      expect(perf.currentPrice).toBeCloseTo(1.0, 5);
    });

    it("should calculate fund performance with one position", () => {
      // Open position and add liquidity (ticks aligned to tickSpacing=10)
      manager.openPosition("pos1", -1000, 1000);
      manager.addLiquidity("pos1", 100000n, 100000n);

      const perf = manager.getFundPerformance();

      expect(perf.totalPositionValue).toBeGreaterThan(0n);
      expect(perf.initialAmount0).toBe(initialAmount0);
      expect(perf.initialAmount1).toBe(initialAmount1);
      
      // Total value should include balance + position value
      expect(perf.totalValue).toBeGreaterThan(0n);
    });

    it("should calculate fund PnL correctly after earning fees", () => {
      // Open position and add liquidity (ticks aligned to tickSpacing=10)
      manager.openPosition("pos1", -1000, 1000);
      manager.addLiquidity("pos1", 500000n, 500000n);

      // Simulate swap event that generates fees
      const sqrtPriceX64 = getSqrtPriceX64();
      const swapEvent = {
        timestamp: Date.now(),
        poolId: "test-pool",
        amountIn: 10000n,
        amountOut: 9900n,
        zeroForOne: true,
        sqrtPriceBefore: sqrtPriceX64,
        sqrtPriceAfter: sqrtPriceX64,
        feeAmount: 30n,
        liquidity: 1000000n,
        tick: 0,
        reserveA: 1010000n,
        reserveB: 990100n,
      };

      manager.onSwapEvent(swapEvent);

      const perf = manager.getFundPerformance();

      expect(perf.totalFeeEarned).toBeGreaterThan(0n);
      // PnL should be positive due to fees (minus any costs)
      expect(perf.totalValue).toBeGreaterThanOrEqual(perf.initialValue);
    });

    it("should track slippage and swap costs", () => {
      // Open position and add liquidity (ticks aligned to tickSpacing=10)
      manager.openPosition("pos1", -1000, 1000);
      manager.addLiquidity("pos1", 500000n, 500000n);

      const perf = manager.getFundPerformance();

      // Should have some swap costs from optimizeForMaxL
      expect(perf.totalSwapCost).toBeGreaterThanOrEqual(0n);
      expect(perf.totalSlippageCost).toBeGreaterThanOrEqual(0n);
    });
  });

  describe("Position Performance", () => {
    it("should calculate performance for single position", () => {
      manager.openPosition("pos1", -1000, 1000);
      manager.addLiquidity("pos1", 100000n, 100000n);

      const perfList = manager.getPositionsPerformance();

      expect(perfList).toHaveLength(1);
      const perf = perfList[0];

      expect(perf.positionId).toBe("pos1");
      expect(perf.lowerTick).toBe(-1000);
      expect(perf.upperTick).toBe(1000);
      expect(perf.status).toBe("active");
      expect(perf.isInRange).toBe(true);
      expect(perf.liquidity).toBeGreaterThan(0n);
      expect(perf.initialAmount0).toBe(100000n);
      expect(perf.initialAmount1).toBe(100000n);
      expect(perf.currentPrice).toBeCloseTo(1.0, 5);
    });

    it("should calculate performance for multiple positions", () => {
      manager.openPosition("pos1", -1000, 1000);
      manager.addLiquidity("pos1", 300000n, 300000n);

      manager.openPosition("pos2", -2000, 2000);
      manager.addLiquidity("pos2", 400000n, 400000n);

      const perfList = manager.getPositionsPerformance();

      expect(perfList).toHaveLength(2);
      expect(perfList[0].positionId).toBe("pos1");
      expect(perfList[1].positionId).toBe("pos2");
    });

    it("should show position as in-range when tick is within bounds", () => {
      manager.openPosition("pos1", -1000, 1000);
      manager.addLiquidity("pos1", 100000n, 100000n);

      const perfList = manager.getPositionsPerformance();
      expect(perfList[0].isInRange).toBe(true);
    });

    it("should calculate position PnL with fees", () => {
      manager.openPosition("pos1", -1000, 1000);
      manager.addLiquidity("pos1", 500000n, 500000n);

      // Simulate swap event
      const sqrtPriceX64 = getSqrtPriceX64();
      const swapEvent = {
        timestamp: Date.now(),
        poolId: "test-pool",
        amountIn: 10000n,
        amountOut: 9900n,
        zeroForOne: true,
        sqrtPriceBefore: sqrtPriceX64,
        sqrtPriceAfter: sqrtPriceX64,
        feeAmount: 30n,
        liquidity: 1000000n,
        tick: 0,
        reserveA: 1010000n,
        reserveB: 990100n,
      };

      manager.onSwapEvent(swapEvent);

      const perfList = manager.getPositionsPerformance();
      const perf = perfList[0];

      expect(perf.totalFeeEarned).toBeGreaterThan(0n);
      expect(perf.positionValue).toBeGreaterThan(perf.initialValue);
      expect(perf.pnl).toBeGreaterThan(0n);
      expect(perf.roiPercent).toBeGreaterThanOrEqual(0);
    });

    it("should show closed position status", () => {
      manager.openPosition("pos1", -1000, 1000);
      manager.addLiquidity("pos1", 100000n, 100000n);
      manager.closePosition("pos1");

      const perfList = manager.getPositionsPerformance();
      expect(perfList[0].status).toBe("closed");
      expect(perfList[0].liquidity).toBe(0n);
    });

    it("should include swap costs and slippage in position performance", () => {
      manager.openPosition("pos1", -1000, 1000);
      manager.addLiquidity("pos1", 500000n, 500000n);

      const perfList = manager.getPositionsPerformance();
      const perf = perfList[0];

      // Should track costs
      expect(perf.swapCost0).toBeGreaterThanOrEqual(0n);
      expect(perf.swapCost1).toBeGreaterThanOrEqual(0n);
      expect(perf.slippage0).toBeGreaterThanOrEqual(0n);
      expect(perf.slippage1).toBeGreaterThanOrEqual(0n);
    });
  });

  describe("CSV Export", () => {
    it("should export performance data to CSV files", async () => {
      manager.openPosition("pos1", -1000, 1000);
      manager.addLiquidity("pos1", 300000n, 300000n);

      manager.openPosition("pos2", -2000, 2000);
      manager.addLiquidity("pos2", 400000n, 400000n);

      const result = await manager.exportPerformanceToCSV("./test-output");

      expect(result.fundCsvPath).toContain("fund_performance_");
      expect(result.fundCsvPath).toContain(".csv");
      expect(result.positionsCsvPath).toContain("position_performance_");
      expect(result.positionsCsvPath).toContain(".csv");
    });
  });

  describe("Performance Calculations", () => {
    it("should calculate ROI correctly", () => {
      manager.openPosition("pos1", -1000, 1000);
      manager.addLiquidity("pos1", 500000n, 500000n);

      // Simulate profitable swap
      const sqrtPriceX64 = getSqrtPriceX64();
      const swapEvent = {
        timestamp: Date.now(),
        poolId: "test-pool",
        amountIn: 50000n,
        amountOut: 49500n,
        zeroForOne: true,
        sqrtPriceBefore: sqrtPriceX64,
        sqrtPriceAfter: sqrtPriceX64,
        feeAmount: 150n,
        liquidity: 1000000n,
        tick: 0,
        reserveA: 1050000n,
        reserveB: 950500n,
      };

      manager.onSwapEvent(swapEvent);

      const fundPerf = manager.getFundPerformance();
      const posPerf = manager.getPositionsPerformance()[0];

      // ROI should be calculated as (PnL / InitialValue) * 100
      if (fundPerf.initialValue > 0n) {
        const expectedRoi = Number((fundPerf.pnl * 10000n) / fundPerf.initialValue) / 100;
        expect(fundPerf.roiPercent).toBeCloseTo(expectedRoi, 2);
      }

      if (posPerf.initialValue > 0n) {
        const expectedRoi = Number((posPerf.pnl * 10000n) / posPerf.initialValue) / 100;
        expect(posPerf.roiPercent).toBeCloseTo(expectedRoi, 2);
      }
    });

    it("should handle zero initial value gracefully", () => {
      const emptyManager = new PositionManager(0n, 0n, pool);
      const perf = emptyManager.getFundPerformance();

      expect(perf.roiPercent).toBe(0);
      expect(perf.initialValue).toBe(0n);
    });
  });
});

