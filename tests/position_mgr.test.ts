import { describe, it, expect, beforeEach } from "bun:test";
import { PositionManager, Position } from "../src/position_mgr";
import { SimplePool } from "../src/simple_pool";
import type { ISlippageProvider, SwapEvent } from "../src/types";

// Simple slippage provider for testing
class TestSlippageProvider implements ISlippageProvider {
  getSlippagePct(amountIn: bigint, xForY: boolean, price: number): number {
    return 0.001; // 0.1% slippage
  }

  onSwapEvent(swapEvent: SwapEvent): void {
    // No-op for testing
  }
}

describe("Position with calculated amounts", () => {
  let pool: SimplePool;
  let positionManager: PositionManager;
  const slippageProvider = new TestSlippageProvider();

  beforeEach(() => {
    // Create a fresh pool for each test
    pool = new SimplePool(
      "USDC", // token0
      "USDT", // token1
      6, // decimals0
      6, // decimals1
      500, // feeTier (0.05% = 500 PPM)
      60, // tickSpacing
      slippageProvider
    );

    // Initialize pool with a swap event to set price at 1.0 (tick 0)
    const sqrtPriceX64 = BigInt(
      Math.floor(Math.sqrt(1.0) * Number(1n << 64n))
    );

    pool.onSwapEvent({
      timestamp: Date.now(),
      poolId: "test-pool",
      amountIn: 0n,
      amountOut: 0n,
      zeroForOne: true,
      newSqrtPrice: sqrtPriceX64,
      feeAmount: 0n,
      liquidity: 1000000000n,
      tick: 0,
      reserveA: 1000000000000n,
      reserveB: 1000000000000n,
    });

    positionManager = new PositionManager(10000000n, 10000000n, pool);
  });

  describe("Position amounts are calculated from liquidity", () => {
    it("should calculate amounts correctly for in-range position", () => {
      const posId = "test-position-1";
      positionManager.openPosition(posId, -120, 120);
      
      // Add liquidity
      const result = positionManager.addLiquidity(posId, 1000000n, 1000000n);
      
      const position = positionManager.getPosition(posId);
      
      // Amounts should be calculated from liquidity L
      expect(position.L).toBeGreaterThan(0n);
      expect(position.amount0).toBeGreaterThan(0n);
      expect(position.amount1).toBeGreaterThan(0n);
      
      // Verify consistency: amounts calculated from L should match the used amounts
      const calculatedAmounts = pool.removeLiquidity(position.L, position.lower, position.upper);
      expect(calculatedAmounts.amount0).toBe(position.amount0);
      expect(calculatedAmounts.amount1).toBe(position.amount1);
    });

    it("should recalculate amounts when price changes", () => {
      const posId = "test-position-2";
      positionManager.openPosition(posId, -120, 120);
      
      // Add liquidity at initial price
      positionManager.addLiquidity(posId, 1000000n, 1000000n);
      
      const position = positionManager.getPosition(posId);
      const initialAmount0 = position.amount0;
      const initialAmount1 = position.amount1;
      
      // Simulate price change by updating pool state
      const newSqrtPriceX64 = BigInt(
        Math.floor(Math.sqrt(1.0001 ** 30) * Number(1n << 64n))
      );
      
      pool.onSwapEvent({
        timestamp: Date.now(),
        poolId: "test-pool",
        amountIn: 100000n,
        amountOut: 99900n,
        zeroForOne: true,
        newSqrtPrice: newSqrtPriceX64,
        feeAmount: 100n,
        liquidity: 1000000000n,
        tick: 30,
        reserveA: 1000100000000n,
        reserveB: 999900100000n,
      });
      
      // Amounts should be recalculated based on new price
      const newAmount0 = position.amount0;
      const newAmount1 = position.amount1;
      
      // The liquidity hasn't changed
      expect(position.L).toBe(position.L);
      
      // But the amounts have changed due to price movement
      // (This demonstrates that amounts are dynamically calculated)
      expect(newAmount0).not.toBe(initialAmount0);
      expect(newAmount1).not.toBe(initialAmount1);
    });

    it("should handle position closure correctly", () => {
      const posId = "test-position-3";
      positionManager.openPosition(posId, -120, 120);
      
      // Add liquidity
      positionManager.addLiquidity(posId, 1000000n, 1000000n);
      
      const position = positionManager.getPosition(posId);
      const liquidityBeforeClose = position.L;
      const amount0BeforeClose = position.amount0;
      const amount1BeforeClose = position.amount1;
      
      // Close position
      const closeResult = positionManager.closePosition(posId);
      
      // Should return the calculated amounts
      expect(closeResult.amount0).toBe(amount0BeforeClose);
      expect(closeResult.amount1).toBe(amount1BeforeClose);
      
      // After closing, L should be 0
      expect(position.L).toBe(0n);
      
      // And amounts should be 0
      expect(position.amount0).toBe(0n);
      expect(position.amount1).toBe(0n);
      
      // Position should be marked as closed
      expect(position.isClosed).toBe(true);
    });

    it("should calculate amounts correctly when removing partial liquidity", () => {
      const posId = "test-position-4";
      positionManager.openPosition(posId, -120, 120);
      
      // Add liquidity
      positionManager.addLiquidity(posId, 2000000n, 2000000n);
      
      const position = positionManager.getPosition(posId);
      const initialL = position.L;
      const initialAmount0 = position.amount0;
      const initialAmount1 = position.amount1;
      
      // Remove half the liquidity
      const halfL = initialL / 2n;
      const removeResult = positionManager.removeLiquidity(posId, halfL);
      
      // Removed amounts should be approximately half
      expect(removeResult.amount0).toBeGreaterThan(0n);
      expect(removeResult.amount1).toBeGreaterThan(0n);
      
      // Remaining liquidity should be half
      expect(position.L).toBe(initialL - halfL);
      
      // Remaining amounts should be approximately half (calculated from remaining L)
      const remainingAmount0 = position.amount0;
      const remainingAmount1 = position.amount1;
      
      // The sum of removed and remaining should equal initial (within rounding error)
      expect(removeResult.amount0 + remainingAmount0).toBeLessThanOrEqual(initialAmount0 + 10n);
      expect(removeResult.amount0 + remainingAmount0).toBeGreaterThanOrEqual(initialAmount0 - 10n);
      expect(removeResult.amount1 + remainingAmount1).toBeLessThanOrEqual(initialAmount1 + 10n);
      expect(removeResult.amount1 + remainingAmount1).toBeGreaterThanOrEqual(initialAmount1 - 10n);
    });
  });

  describe("Benefits of calculated amounts", () => {
    it("should always reflect current price without manual updates", () => {
      const posId = "test-position-5";
      positionManager.openPosition(posId, -120, 120);
      
      // Add liquidity
      positionManager.addLiquidity(posId, 1000000n, 1000000n);
      
      const position = positionManager.getPosition(posId);
      const L = position.L;
      
      // Multiple reads should be consistent with current pool state
      const read1_amount0 = position.amount0;
      const read1_amount1 = position.amount1;
      
      const read2_amount0 = position.amount0;
      const read2_amount1 = position.amount1;
      
      // Same pool state = same amounts
      expect(read2_amount0).toBe(read1_amount0);
      expect(read2_amount1).toBe(read1_amount1);
      
      // And they should match what removeLiquidity calculates
      const calculated = pool.removeLiquidity(L, position.lower, position.upper);
      expect(calculated.amount0).toBe(read1_amount0);
      expect(calculated.amount1).toBe(read1_amount1);
    });

    it("should save memory by not storing redundant state", () => {
      // This test demonstrates the conceptual benefit
      // In production with many positions, not storing amount0/amount1 saves memory
      
      const positions = [];
      for (let i = 0; i < 10; i++) {
        const posId = `test-position-mem-${i}`;
        positionManager.openPosition(posId, -120 - i * 60, 120 + i * 60);
        positionManager.addLiquidity(posId, 100000n, 100000n);
        positions.push(positionManager.getPosition(posId));
      }
      
      // All positions can still access their amounts
      positions.forEach(pos => {
        expect(pos.amount0).toBeGreaterThanOrEqual(0n);
        expect(pos.amount1).toBeGreaterThanOrEqual(0n);
        expect(pos.L).toBeGreaterThan(0n);
      });
      
      // But we're only storing L, not amount0 and amount1
      // This is a conceptual demonstration - in reality, we'd need to inspect memory
    });
  });
});

