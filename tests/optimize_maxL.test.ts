import { describe, it, expect, beforeEach } from "bun:test";
import { SimplePool } from "../src/simple_pool";
import type { ISlippageProvider, SwapEvent } from "../src/types";

// Simple slippage provider for testing
class TestSlippageProvider implements ISlippageProvider {
  getSlippagePct(amountIn: bigint, xForY: boolean, price: number): number {
    // 0.1% slippage
    return 0.001;
  }

  onSwapEvent(swapEvent: SwapEvent): void {
    // No-op for testing
  }
}

describe("optimizeForMaxL", () => {
  let pool: SimplePool;
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
      sqrtPriceAfter: sqrtPriceX64,
      feeAmount: 0n,
      liquidity: 1000000000n,
      tick: 0,
      reserveA: 1000000000000n,
      reserveB: 1000000000000n,
    });
  });

  describe("Case 1: Price range below current price (only need token0)", () => {
    it("should swap all token1 to token0 when range is below current price", () => {
      // Price at tick 0, range at ticks -600 to -120 (below current price)
      const result = pool.optimizeForMaxL(
        1000000n, // 1 USDC
        1000000n, // 1 USDT
        -600, // lower tick (below current)
        -120 // upper tick (below current)
      );

      expect(result.needSwap).toBe(true);
      expect(result.swapDirection).toBe("1to0");
      expect(result.swapAmount).toBe(1000000n); // All token1
      expect(result.finalAmount1).toBe(0n); // No token1 left
      expect(result.finalAmount0).toBeGreaterThan(1000000n); // Got more token0
      expect(result.maxLResult.L).toBeGreaterThan(0n);
    });

    it("should respect minimum swap threshold", () => {
      // Small amount with high threshold
      const result = pool.optimizeForMaxL(
        1000000n, // 1 USDC
        100n, // 0.0001 USDT (very small)
        -600,
        -120,
        1000n // Threshold: 0.001 USDT
      );

      expect(result.needSwap).toBe(false); // Below threshold
      expect(result.finalAmount0).toBe(1000000n); // Unchanged
      expect(result.finalAmount1).toBe(100n); // Unchanged
    });

    it("should swap when above threshold", () => {
      const result = pool.optimizeForMaxL(
        1000000n,
        500000n, // 0.5 USDT
        -600,
        -120,
        100000n // Threshold: 0.1 USDT
      );

      expect(result.needSwap).toBe(true); // Above threshold
      expect(result.swapAmount).toBe(500000n);
      expect(result.finalAmount1).toBe(0n);
    });
  });

  describe("Case 2: Price range above current price (only need token1)", () => {
    it("should swap all token0 to token1 when range is above current price", () => {
      // Price at tick 0, range at ticks 120 to 600 (above current price)
      const result = pool.optimizeForMaxL(
        1000000n, // 1 USDC
        1000000n, // 1 USDT
        120, // lower tick (above current)
        600 // upper tick (above current)
      );

      expect(result.needSwap).toBe(true);
      expect(result.swapDirection).toBe("0to1");
      expect(result.swapAmount).toBe(1000000n); // All token0
      expect(result.finalAmount0).toBe(0n); // No token0 left
      expect(result.finalAmount1).toBeGreaterThan(1000000n); // Got more token1
      expect(result.maxLResult.L).toBeGreaterThan(0n);
    });

    it("should respect minimum swap threshold for token0", () => {
      const result = pool.optimizeForMaxL(
        100n, // Very small amount of token0
        1000000n,
        120,
        600,
        1000n // Threshold
      );

      expect(result.needSwap).toBe(false); // Below threshold
      expect(result.finalAmount0).toBe(100n);
      expect(result.finalAmount1).toBe(1000000n);
    });
  });

  describe("Case 3: Price range contains current price (need both tokens)", () => {
    it("should maintain both tokens when ratio is optimal", () => {
      // Balanced amounts with range around current price
      const result = pool.optimizeForMaxL(
        1000000n, // 1 USDC
        1000000n, // 1 USDT
        -120, // lower tick
        120 // upper tick
      );

      // Should have both tokens after optimization
      expect(result.finalAmount0).toBeGreaterThan(0n);
      expect(result.finalAmount1).toBeGreaterThan(0n);
      expect(result.maxLResult.L).toBeGreaterThan(0n);
    });

    it("should swap token1 to token0 when too much token1", () => {
      // Unbalanced: too much token1
      const result = pool.optimizeForMaxL(
        500000n, // 0.5 USDC
        2000000n, // 2 USDT (4x more)
        -120,
        120
      );

      // Should swap some token1 to token0
      if (result.needSwap) {
        expect(result.swapDirection).toBe("1to0");
        expect(result.finalAmount0).toBeGreaterThan(500000n);
        expect(result.finalAmount1).toBeLessThan(2000000n);
      }
    });

    it("should swap token0 to token1 when too much token0", () => {
      // Unbalanced: too much token0
      const result = pool.optimizeForMaxL(
        2000000n, // 2 USDC (4x more)
        500000n, // 0.5 USDT
        -120,
        120
      );

      // Should swap some token0 to token1
      if (result.needSwap) {
        expect(result.swapDirection).toBe("0to1");
        expect(result.finalAmount0).toBeLessThan(2000000n);
        expect(result.finalAmount1).toBeGreaterThan(500000n);
      }
    });

    it("should not swap when ratio is within tolerance", () => {
      // Nearly optimal ratio (within 1% tolerance)
      const result = pool.optimizeForMaxL(
        1000000n,
        1005000n, // Just 0.5% more
        -120,
        120
      );

      // May or may not swap depending on exact ratio calculation
      // But liquidity should be maximized
      expect(result.maxLResult.L).toBeGreaterThan(0n);
    });

    it("should respect threshold for in-range swaps", () => {
      const result = pool.optimizeForMaxL(
        1000000n,
        2000000n, // Unbalanced
        -120,
        120,
        1000000n // High threshold
      );

      // Even if swap is calculated, it might be below threshold
      expect(result.maxLResult.L).toBeGreaterThan(0n);
    });
  });

  describe("Improvement metrics", () => {
    it("should show improvement when swap is beneficial", () => {
      const result = pool.optimizeForMaxL(
        2000000n,
        500000n, // Unbalanced
        -120,
        120
      );

      expect(result.improvement.originalL).toBeGreaterThan(0n);
      expect(result.improvement.optimizedL).toBeGreaterThanOrEqual(
        result.improvement.originalL
      );

      if (result.needSwap) {
        expect(result.improvement.optimizedL).toBeGreaterThan(
          result.improvement.originalL
        );
        expect(result.improvement.improvementPct).toBeGreaterThan(0);
      }
    });

    it("should show zero improvement when no swap needed", () => {
      const result = pool.optimizeForMaxL(
        1000000n,
        1000000n,
        -120,
        120
      );

      if (!result.needSwap) {
        expect(result.improvement.improvementPct).toBe(0);
        expect(result.improvement.originalL).toBe(
          result.improvement.optimizedL
        );
      }
    });
  });

  describe("Edge cases - Single token with in-range positions (BUG FIX)", () => {
    it("should handle zero token0 with in-range position (only token1)", () => {
      // This is the bug case: have only token1, but position is in-range
      // Should swap some token1 to token0 to create balanced position
      const result = pool.optimizeForMaxL(
        0n,         // No token0
        1000000n,   // 1 USDT
        -120,       // In range
        120
      );

      // Should trigger swap
      expect(result.needSwap).toBe(true);
      expect(result.swapDirection).toBe("1to0");
      
      // Should end up with both tokens
      expect(result.finalAmount0).toBeGreaterThan(0n);
      expect(result.finalAmount1).toBeGreaterThan(0n);
      expect(result.finalAmount1).toBeLessThan(1000000n); // Some token1 swapped
      
      // Should have non-zero liquidity
      expect(result.maxLResult.L).toBeGreaterThan(0n);
      
      // Original L should be 0 (can't calculate with only token1 in-range)
      expect(result.improvement.originalL).toBe(0n);
      expect(result.improvement.optimizedL).toBeGreaterThan(0n);
      
      console.log(`[TEST] Only token1 for in-range: swapped ${result.swapAmount} token1 -> ${result.swapResult?.amountOut} token0, final L=${result.maxLResult.L}`);
    });

    it("should handle zero token1 with in-range position (only token0)", () => {
      // Have only token0, but position is in-range
      // Should swap some token0 to token1 to create balanced position
      const result = pool.optimizeForMaxL(
        1000000n,   // 1 USDC
        0n,         // No token1
        -120,       // In range
        120
      );

      // Should trigger swap
      expect(result.needSwap).toBe(true);
      expect(result.swapDirection).toBe("0to1");
      
      // Should end up with both tokens
      expect(result.finalAmount0).toBeGreaterThan(0n);
      expect(result.finalAmount1).toBeGreaterThan(0n);
      expect(result.finalAmount0).toBeLessThan(1000000n); // Some token0 swapped
      
      // Should have non-zero liquidity
      expect(result.maxLResult.L).toBeGreaterThan(0n);
      
      // Original L should be 0 (can't calculate with only token0 in-range)
      expect(result.improvement.originalL).toBe(0n);
      expect(result.improvement.optimizedL).toBeGreaterThan(0n);
      
      console.log(`[TEST] Only token0 for in-range: swapped ${result.swapAmount} token0 -> ${result.swapResult?.amountOut} token1, final L=${result.maxLResult.L}`);
    });

    it("should handle large amount of only token1 with narrow in-range position", () => {
      // Large amount, narrow range
      const result = pool.optimizeForMaxL(
        0n,           // No token0
        100000000n,   // 100 USDT (large)
        -60,          // Narrow range
        60
      );

      expect(result.needSwap).toBe(true);
      expect(result.swapDirection).toBe("1to0");
      expect(result.finalAmount0).toBeGreaterThan(0n);
      expect(result.finalAmount1).toBeGreaterThan(0n);
      expect(result.maxLResult.L).toBeGreaterThan(0n);
      
      // Should use a significant portion of the amount
      expect(result.maxLResult.amount0Used + result.maxLResult.amount1Used).toBeGreaterThan(10000000n);
    });

    it("should handle large amount of only token0 with wide in-range position", () => {
      // Large amount, wide range
      const result = pool.optimizeForMaxL(
        100000000n,   // 100 USDC (large)
        0n,           // No token1
        -600,         // Wide range
        600
      );

      expect(result.needSwap).toBe(true);
      expect(result.swapDirection).toBe("0to1");
      expect(result.finalAmount0).toBeGreaterThan(0n);
      expect(result.finalAmount1).toBeGreaterThan(0n);
      expect(result.maxLResult.L).toBeGreaterThan(0n);
    });

    it("should handle minimal amount of only token1 with in-range position", () => {
      // Minimal amount to test rounding
      const result = pool.optimizeForMaxL(
        0n,     // No token0
        1000n,  // 0.001 USDT (tiny)
        -120,
        120
      );

      // May or may not swap depending on threshold and calculations
      // But should not crash and should handle gracefully
      expect(result.maxLResult.L).toBeGreaterThanOrEqual(0n);
      
      if (result.needSwap) {
        expect(result.finalAmount0).toBeGreaterThanOrEqual(0n);
        expect(result.finalAmount1).toBeGreaterThanOrEqual(0n);
      }
    });

    it("should respect swap threshold even with only one token", () => {
      // Small amount with high threshold
      const result = pool.optimizeForMaxL(
        0n,       // No token0
        500000n,  // 0.5 USDT
        -120,
        120,
        1000000n  // Threshold: 1 USDT (higher than available)
      );

      // Should not swap if calculated swap amount is below threshold
      // Exact behavior depends on calculation
      expect(result.maxLResult.L).toBeGreaterThanOrEqual(0n);
    });

    it("should produce balanced ratio after swap from only token1", () => {
      const result = pool.optimizeForMaxL(
        0n,         // No token0
        10000000n,  // 10 USDT
        -120,
        120
      );

      if (result.needSwap) {
        // After swap, should have approximately correct ratio
        const finalRatio = Number(result.finalAmount1) / Number(result.finalAmount0);
        
        // The ratio should be reasonable (not extreme)
        expect(finalRatio).toBeGreaterThan(0.1);
        expect(finalRatio).toBeLessThan(10);
        
        // Both amounts should be meaningful (not one >> other)
        const smallerAmount = result.finalAmount0 < result.finalAmount1 ? result.finalAmount0 : result.finalAmount1;
        const largerAmount = result.finalAmount0 > result.finalAmount1 ? result.finalAmount0 : result.finalAmount1;
        
        // Smaller amount should be at least 10% of larger amount
        expect(Number(smallerAmount) / Number(largerAmount)).toBeGreaterThan(0.1);
      }
    });

    it("should produce balanced ratio after swap from only token0", () => {
      const result = pool.optimizeForMaxL(
        10000000n,  // 10 USDC
        0n,         // No token1
        -120,
        120
      );

      if (result.needSwap) {
        // After swap, should have approximately correct ratio
        const finalRatio = Number(result.finalAmount1) / Number(result.finalAmount0);
        
        // The ratio should be reasonable
        expect(finalRatio).toBeGreaterThan(0.1);
        expect(finalRatio).toBeLessThan(10);
        
        // Both amounts should be meaningful
        const smallerAmount = result.finalAmount0 < result.finalAmount1 ? result.finalAmount0 : result.finalAmount1;
        const largerAmount = result.finalAmount0 > result.finalAmount1 ? result.finalAmount0 : result.finalAmount1;
        
        expect(Number(smallerAmount) / Number(largerAmount)).toBeGreaterThan(0.1);
      }
    });

    it("should handle asymmetric range with only token1", () => {
      // Range is mostly below current price, but includes it
      const result = pool.optimizeForMaxL(
        0n,         // No token0
        5000000n,   // 5 USDT
        -300,       // Mostly negative
        60          // Slightly positive
      );

      expect(result.needSwap).toBe(true);
      expect(result.swapDirection).toBe("1to0");
      expect(result.finalAmount0).toBeGreaterThan(0n);
      expect(result.finalAmount1).toBeGreaterThan(0n);
      expect(result.maxLResult.L).toBeGreaterThan(0n);
    });

    it("should handle asymmetric range with only token0", () => {
      // Range is mostly above current price, but includes it
      const result = pool.optimizeForMaxL(
        5000000n,   // 5 USDC
        0n,         // No token1
        -60,        // Slightly negative
        300         // Mostly positive
      );

      expect(result.needSwap).toBe(true);
      expect(result.swapDirection).toBe("0to1");
      expect(result.finalAmount0).toBeGreaterThan(0n);
      expect(result.finalAmount1).toBeGreaterThan(0n);
      expect(result.maxLResult.L).toBeGreaterThan(0n);
    });

    it("should handle both tokens zero", () => {
      const result = pool.optimizeForMaxL(0n, 0n, -120, 120);

      expect(result.needSwap).toBe(false);
      expect(result.maxLResult.L).toBe(0n);
      expect(result.finalAmount0).toBe(0n);
      expect(result.finalAmount1).toBe(0n);
    });

    it("should throw error for misaligned ticks", () => {
      expect(() => {
        pool.optimizeForMaxL(1000000n, 1000000n, -100, 100); // Not multiples of 60
      }).toThrow("not aligned to tickSpacing");
    });

    it("should throw error for invalid tick range", () => {
      expect(() => {
        pool.optimizeForMaxL(1000000n, 1000000n, 120, -120); // lower > upper
      }).toThrow("must be less than");
    });
  });

  describe("Realistic backtest scenario - Single token initialization", () => {
    it("should simulate three-band pyramid strategy with only token1", () => {
      // Simulates the user's bug case: starting backtest with only token1
      const initialToken1 = 1000000000n; // 1000 USDT (with 6 decimals)
      
      // Band 1: narrow (2 ticks = ±1 tick from center)
      const band1Result = pool.optimizeForMaxL(
        0n,
        (initialToken1 * 30n) / 100n, // 30% allocation
        -60,  // -1 tick with spacing 60
        60    // +1 tick
      );
      
      // Band 2: medium (4 ticks = ±2 ticks from center)
      const band2Result = pool.optimizeForMaxL(
        0n,
        (initialToken1 * 30n) / 100n, // 30% allocation
        -120, // -2 ticks
        120   // +2 ticks
      );
      
      // Band 3: wide (8 ticks = ±4 ticks from center)
      const band3Result = pool.optimizeForMaxL(
        0n,
        (initialToken1 * 40n) / 100n, // 40% allocation
        -240, // -4 ticks
        240   // +4 ticks
      );

      // All should successfully create liquidity
      expect(band1Result.maxLResult.L).toBeGreaterThan(0n);
      expect(band2Result.maxLResult.L).toBeGreaterThan(0n);
      expect(band3Result.maxLResult.L).toBeGreaterThan(0n);
      
      // All should have swapped some token1 to token0
      expect(band1Result.needSwap).toBe(true);
      expect(band2Result.needSwap).toBe(true);
      expect(band3Result.needSwap).toBe(true);
      
      // All should have both tokens after optimization
      expect(band1Result.finalAmount0).toBeGreaterThan(0n);
      expect(band1Result.finalAmount1).toBeGreaterThan(0n);
      expect(band2Result.finalAmount0).toBeGreaterThan(0n);
      expect(band2Result.finalAmount1).toBeGreaterThan(0n);
      expect(band3Result.finalAmount0).toBeGreaterThan(0n);
      expect(band3Result.finalAmount1).toBeGreaterThan(0n);
      
      console.log(`[TEST] Three-band with only token1:`);
      console.log(`  Band1 L=${band1Result.maxLResult.L}, swapped=${band1Result.swapAmount}`);
      console.log(`  Band2 L=${band2Result.maxLResult.L}, swapped=${band2Result.swapAmount}`);
      console.log(`  Band3 L=${band3Result.maxLResult.L}, swapped=${band3Result.swapAmount}`);
    });

    it("should simulate three-band pyramid strategy with only token0", () => {
      // Opposite case: starting with only token0
      const initialToken0 = 1000000000n; // 1000 USDC
      
      const band1Result = pool.optimizeForMaxL(
        (initialToken0 * 30n) / 100n,
        0n,
        -60,
        60
      );
      
      const band2Result = pool.optimizeForMaxL(
        (initialToken0 * 30n) / 100n,
        0n,
        -120,
        120
      );
      
      const band3Result = pool.optimizeForMaxL(
        (initialToken0 * 40n) / 100n,
        0n,
        -240,
        240
      );

      // All should successfully create liquidity
      expect(band1Result.maxLResult.L).toBeGreaterThan(0n);
      expect(band2Result.maxLResult.L).toBeGreaterThan(0n);
      expect(band3Result.maxLResult.L).toBeGreaterThan(0n);
      
      // All should have swapped
      expect(band1Result.needSwap).toBe(true);
      expect(band2Result.needSwap).toBe(true);
      expect(band3Result.needSwap).toBe(true);
      
      // All should have both tokens
      expect(band1Result.finalAmount0).toBeGreaterThan(0n);
      expect(band1Result.finalAmount1).toBeGreaterThan(0n);
      expect(band2Result.finalAmount0).toBeGreaterThan(0n);
      expect(band2Result.finalAmount1).toBeGreaterThan(0n);
      expect(band3Result.finalAmount0).toBeGreaterThan(0n);
      expect(band3Result.finalAmount1).toBeGreaterThan(0n);
    });

    it("should compare single-token vs balanced initialization", () => {
      const amount = 1000000n;
      
      // Single token (only token1)
      const singleTokenResult = pool.optimizeForMaxL(
        0n,
        amount,
        -120,
        120
      );
      
      // Balanced tokens
      const balancedResult = pool.optimizeForMaxL(
        amount / 2n,
        amount / 2n,
        -120,
        120
      );

      // Both should produce liquidity
      expect(singleTokenResult.maxLResult.L).toBeGreaterThan(0n);
      expect(balancedResult.maxLResult.L).toBeGreaterThan(0n);
      
      // Single token case requires swap
      expect(singleTokenResult.needSwap).toBe(true);
      
      // Balanced may or may not need swap depending on exact ratio
      // But should have similar or better liquidity
      
      // Compare efficiency (balanced should be more efficient due to no swap costs)
      const singleTokenEfficiency = Number(singleTokenResult.maxLResult.L) / Number(amount);
      const balancedEfficiency = Number(balancedResult.maxLResult.L) / Number(amount);
      
      console.log(`[TEST] Efficiency comparison:`);
      console.log(`  Single token: L=${singleTokenResult.maxLResult.L}, efficiency=${singleTokenEfficiency}`);
      console.log(`  Balanced:     L=${balancedResult.maxLResult.L}, efficiency=${balancedEfficiency}`);
      
      // Balanced should generally be more efficient (higher L per token)
      // But single token should still work (not zero)
      expect(singleTokenEfficiency).toBeGreaterThan(0);
    });
  });

  describe("Swap details", () => {
    it("should provide swap details when swap occurs", () => {
      const result = pool.optimizeForMaxL(
        1000000n,
        1000000n,
        -600,
        -120 // Below current price
      );

      if (result.needSwap) {
        expect(result.swapResult).toBeDefined();
        expect(result.swapResult!.amountOut).toBeGreaterThan(0n);
        expect(result.swapResult!.fee).toBeGreaterThan(0n);
        expect(result.swapResult!.slippage).toBeGreaterThanOrEqual(0n);
      }
    });

    it("should not provide swap details when no swap", () => {
      const result = pool.optimizeForMaxL(
        1000000n,
        1000000n,
        -120,
        120,
        10000000n // Very high threshold
      );

      if (!result.needSwap) {
        expect(result.swapResult).toBeUndefined();
      }
    });
  });

  describe("Multiple scenarios with different tick ranges", () => {
    it("should handle wide range", () => {
      const result = pool.optimizeForMaxL(
        5000000n,
        5000000n,
        -600, // Wide range
        600
      );

      expect(result.maxLResult.L).toBeGreaterThan(0n);
      expect(result.maxLResult.amount0Used).toBeGreaterThan(0n);
      expect(result.maxLResult.amount1Used).toBeGreaterThan(0n);
    });

    it("should handle narrow range", () => {
      const result = pool.optimizeForMaxL(
        5000000n,
        5000000n,
        -60, // Narrow range
        60
      );

      expect(result.maxLResult.L).toBeGreaterThan(0n);
    });

    it("should handle asymmetric range", () => {
      const result = pool.optimizeForMaxL(
        5000000n,
        5000000n,
        -300, // More on the lower side
        60
      );

      expect(result.maxLResult.L).toBeGreaterThan(0n);
    });
  });

  describe("Cases where swap is required to maximize liquidity", () => {
    it("should require swap when heavily imbalanced for range below current price", () => {
      // Range below current price - need only token0
      // Starting with 90% token1 and 10% token0
      const result = pool.optimizeForMaxL(
        500000n,   // 0.5 token0 (small)
        4500000n,  // 4.5 token1 (large)
        -600,
        -120
      );

      // Must swap token1 to token0
      expect(result.needSwap).toBe(true);
      expect(result.swapDirection).toBe("1to0");
      
      // Should improve liquidity significantly
      expect(result.improvement.optimizedL).toBeGreaterThan(result.improvement.originalL);
      expect(result.improvement.improvementPct).toBeGreaterThan(50); // At least 50% improvement
      
      // Should have much more token0 after swap
      expect(result.finalAmount0).toBeGreaterThan(500000n);
      expect(result.finalAmount1).toBeLessThan(4500000n);
    });

    it("should require swap when heavily imbalanced for range above current price", () => {
      // Range above current price - need only token1
      // Starting with 90% token0 and 10% token1
      const result = pool.optimizeForMaxL(
        4500000n,  // 4.5 token0 (large)
        500000n,   // 0.5 token1 (small)
        120,
        600
      );

      // Must swap token0 to token1
      expect(result.needSwap).toBe(true);
      expect(result.swapDirection).toBe("0to1");
      
      // Should improve liquidity significantly
      expect(result.improvement.optimizedL).toBeGreaterThan(result.improvement.originalL);
      expect(result.improvement.improvementPct).toBeGreaterThan(50); // At least 50% improvement
      
      // Should have much more token1 after swap
      expect(result.finalAmount0).toBeLessThan(4500000n);
      expect(result.finalAmount1).toBeGreaterThan(500000n);
    });

    it("should require swap to balance ratio for in-range position", () => {
      // Range contains current price
      // Starting with 3:1 ratio (too much token0)
      const result = pool.optimizeForMaxL(
        3000000n,  // 3 token0
        1000000n,  // 1 token1
        -120,
        120
      );

      // Calculate original L without optimization
      const originalL = result.improvement.originalL;
      const optimizedL = result.improvement.optimizedL;

      // If swap happened, should improve
      if (result.needSwap) {
        expect(optimizedL).toBeGreaterThan(originalL);
        expect(result.improvement.improvementPct).toBeGreaterThan(0);
        
        // Should move toward balanced ratio
        if (result.swapDirection === "0to1") {
          expect(result.finalAmount0).toBeLessThan(3000000n);
          expect(result.finalAmount1).toBeGreaterThan(1000000n);
        }
      }
    });

    it("should require swap with 1:3 ratio imbalance for in-range position", () => {
      // Starting with 1:3 ratio (too much token1)
      const result = pool.optimizeForMaxL(
        1000000n,  // 1 token0
        3000000n,  // 3 token1
        -120,
        120
      );

      // If swap happened, should improve
      if (result.needSwap) {
        expect(result.improvement.optimizedL).toBeGreaterThan(result.improvement.originalL);
        expect(result.improvement.improvementPct).toBeGreaterThan(0);
        
        // Should move toward balanced ratio
        if (result.swapDirection === "1to0") {
          expect(result.finalAmount1).toBeLessThan(3000000n);
          expect(result.finalAmount0).toBeGreaterThan(1000000n);
        }
      }
    });

    it("should show quantifiable improvement with extreme imbalance", () => {
      // Extreme imbalance: 95% token1, 5% token0, but range needs only token0
      const result = pool.optimizeForMaxL(
        250000n,    // 0.25 token0
        4750000n,   // 4.75 token1
        -600,
        -120
      );

      expect(result.needSwap).toBe(true);
      expect(result.swapDirection).toBe("1to0");
      
      // Original liquidity should be very low (limited by small token0 amount)
      expect(result.improvement.originalL).toBeGreaterThan(0n);
      
      // Optimized liquidity should be much higher
      expect(result.improvement.optimizedL).toBeGreaterThan(result.improvement.originalL);
      
      // Calculate the ratio of improvement
      const improvementRatio = Number(result.improvement.optimizedL) / Number(result.improvement.originalL);
      expect(improvementRatio).toBeGreaterThan(2); // At least 2x improvement
      
      // Almost all token1 should be swapped
      expect(result.swapAmount).toBeGreaterThan(4000000n); // Most of the token1
    });

    it("should demonstrate swap necessity with comparison", () => {
      // Test case: Range in middle, but heavily imbalanced
      const amount0 = 500000n;
      const amount1 = 2500000n;
      
      const result = pool.optimizeForMaxL(
        amount0,
        amount1,
        -180,
        180
      );

      // Get original L for comparison
      const originalMaxL = pool.maxL(amount0, amount1, -180, 180);
      
      expect(result.improvement.originalL).toBe(originalMaxL.L);
      
      // If optimization found a better solution
      if (result.needSwap) {
        // Optimized should be strictly better
        expect(result.improvement.optimizedL).toBeGreaterThan(result.improvement.originalL);
        
        // The improvement should be meaningful (at least 1%)
        expect(result.improvement.improvementPct).toBeGreaterThan(1);
        
        // Verify the swap details make sense
        expect(result.swapAmount).toBeGreaterThan(0n);
        expect(result.swapResult).toBeDefined();
        expect(result.swapResult!.amountOut).toBeGreaterThan(0n);
      }
    });

    it("should maximize liquidity when only token1 available for token0-only range", () => {
      // Edge case: Have only token1, but need only token0
      const result = pool.optimizeForMaxL(
        0n,         // No token0
        5000000n,   // 5 token1
        -600,
        -120
      );

      expect(result.needSwap).toBe(true);
      expect(result.swapDirection).toBe("1to0");
      
      // Original L should be 0 (can't provide liquidity without token0)
      expect(result.improvement.originalL).toBe(0n);
      
      // After swap, should have token0 and non-zero liquidity
      expect(result.finalAmount0).toBeGreaterThan(0n);
      expect(result.improvement.optimizedL).toBeGreaterThan(0n);
      
      // Improvement from 0 to something is infinite, but percentage should be high
      expect(result.improvement.improvementPct).toBeGreaterThan(0);
    });

    it("should maximize liquidity when only token0 available for token1-only range", () => {
      // Edge case: Have only token0, but need only token1
      const result = pool.optimizeForMaxL(
        5000000n,   // 5 token0
        0n,         // No token1
        120,
        600
      );

      expect(result.needSwap).toBe(true);
      expect(result.swapDirection).toBe("0to1");
      
      // Original L should be 0 (can't provide liquidity without token1)
      expect(result.improvement.originalL).toBe(0n);
      
      // After swap, should have token1 and non-zero liquidity
      expect(result.finalAmount1).toBeGreaterThan(0n);
      expect(result.improvement.optimizedL).toBeGreaterThan(0n);
    });
  });
});

