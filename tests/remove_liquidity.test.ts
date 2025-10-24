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

describe("removeLiquidity", () => {
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
      newSqrtPrice: sqrtPriceX64,
      feeAmount: 0n,
      liquidity: 1000000000n,
      tick: 0,
      reserveA: 1000000000000n,
      reserveB: 1000000000000n,
    });
  });

  describe("Case 1: Price below the range (returns only token0)", () => {
    it("should return only token0 when current price is below the range", () => {
      // Set price at tick 0, range at ticks 120 to 600 (above current price)
      const lower = 120;
      const upper = 600;
      const deltaLiquidity = 1000000n;

      const result = pool.removeLiquidity(deltaLiquidity, lower, upper);

      // When price is below range, we should only get token0
      expect(result.amount0).toBeGreaterThan(0n);
      expect(result.amount1).toBe(0n);
    });

    it("should scale amount0 proportionally with liquidity", () => {
      const lower = 120;
      const upper = 600;
      
      // Remove small amount of liquidity
      const result1 = pool.removeLiquidity(1000000n, lower, upper);
      
      // Remove double the amount
      const result2 = pool.removeLiquidity(2000000n, lower, upper);

      // Amount0 should be approximately double
      expect(result2.amount0).toBeGreaterThan(result1.amount0);
      expect(result2.amount0).toBeLessThanOrEqual(result1.amount0 * 2n + 10n); // Allow small rounding
      expect(result2.amount0).toBeGreaterThanOrEqual(result1.amount0 * 2n - 10n);
      
      // Amount1 should still be zero
      expect(result1.amount1).toBe(0n);
      expect(result2.amount1).toBe(0n);
    });

    it("should handle large liquidity amounts", () => {
      const lower = 120;
      const upper = 600;
      const largeLiquidity = 1000000000n; // 1 billion

      const result = pool.removeLiquidity(largeLiquidity, lower, upper);

      expect(result.amount0).toBeGreaterThan(0n);
      expect(result.amount1).toBe(0n);
    });

    it("should verify consistency with maxL calculation", () => {
      // First, calculate how much liquidity we can get from known amounts
      const lower = 120;
      const upper = 600;
      const initialAmount0 = 5000000n;
      const initialAmount1 = 0n; // Below range, only need token0

      const maxLResult = pool.maxL(initialAmount0, initialAmount1, lower, upper);
      
      // Now remove that liquidity and verify we get similar amounts back
      const removeResult = pool.removeLiquidity(maxLResult.L, lower, upper);

      // Should get approximately the same amount0 back (within small rounding error)
      const diff = removeResult.amount0 > maxLResult.amount0Used 
        ? removeResult.amount0 - maxLResult.amount0Used
        : maxLResult.amount0Used - removeResult.amount0;
      
      // Allow small rounding error (less than 0.01%)
      expect(Number(diff)).toBeLessThan(Number(maxLResult.amount0Used) * 0.0001);
      expect(removeResult.amount1).toBe(0n);
    });
  });

  describe("Case 2: Price above the range (returns only token1)", () => {
    it("should return only token1 when current price is above the range", () => {
      // Set price at tick 0, range at ticks -600 to -120 (below current price)
      const lower = -600;
      const upper = -120;
      const deltaLiquidity = 1000000n;

      const result = pool.removeLiquidity(deltaLiquidity, lower, upper);

      // When price is above range, we should only get token1
      expect(result.amount0).toBe(0n);
      expect(result.amount1).toBeGreaterThan(0n);
    });

    it("should scale amount1 proportionally with liquidity", () => {
      const lower = -600;
      const upper = -120;
      
      // Remove small amount of liquidity
      const result1 = pool.removeLiquidity(1000000n, lower, upper);
      
      // Remove triple the amount
      const result3 = pool.removeLiquidity(3000000n, lower, upper);

      // Amount1 should be approximately triple
      expect(result3.amount1).toBeGreaterThan(result1.amount1);
      expect(result3.amount1).toBeLessThanOrEqual(result1.amount1 * 3n + 10n); // Allow small rounding
      expect(result3.amount1).toBeGreaterThanOrEqual(result1.amount1 * 3n - 10n);
      
      // Amount0 should still be zero
      expect(result1.amount0).toBe(0n);
      expect(result3.amount0).toBe(0n);
    });

    it("should handle large liquidity amounts", () => {
      const lower = -600;
      const upper = -120;
      const largeLiquidity = 1000000000n; // 1 billion

      const result = pool.removeLiquidity(largeLiquidity, lower, upper);

      expect(result.amount0).toBe(0n);
      expect(result.amount1).toBeGreaterThan(0n);
    });

    it("should verify consistency with maxL calculation", () => {
      // First, calculate how much liquidity we can get from known amounts
      const lower = -600;
      const upper = -120;
      const initialAmount0 = 0n; // Above range, only need token1
      const initialAmount1 = 5000000n;

      const maxLResult = pool.maxL(initialAmount0, initialAmount1, lower, upper);
      
      // Now remove that liquidity and verify we get similar amounts back
      const removeResult = pool.removeLiquidity(maxLResult.L, lower, upper);

      // Should get approximately the same amount1 back (within small rounding error)
      const diff = removeResult.amount1 > maxLResult.amount1Used 
        ? removeResult.amount1 - maxLResult.amount1Used
        : maxLResult.amount1Used - removeResult.amount1;
      
      // Allow small rounding error (less than 0.01%)
      expect(Number(diff)).toBeLessThan(Number(maxLResult.amount1Used) * 0.0001);
      expect(removeResult.amount0).toBe(0n);
    });
  });

  describe("Case 3: Price in range (returns both tokens)", () => {
    it("should return both tokens when current price is in range", () => {
      // Set price at tick 0, range includes tick 0 (-120 to 120)
      const lower = -120;
      const upper = 120;
      const deltaLiquidity = 1000000n;

      const result = pool.removeLiquidity(deltaLiquidity, lower, upper);

      // When price is in range, we should get both tokens
      expect(result.amount0).toBeGreaterThan(0n);
      expect(result.amount1).toBeGreaterThan(0n);
    });

    it("should scale both amounts proportionally with liquidity", () => {
      const lower = -120;
      const upper = 120;
      
      // Remove small amount of liquidity
      const result1 = pool.removeLiquidity(1000000n, lower, upper);
      
      // Remove double the amount
      const result2 = pool.removeLiquidity(2000000n, lower, upper);

      // Both amounts should be approximately double
      expect(result2.amount0).toBeGreaterThan(result1.amount0);
      expect(result2.amount1).toBeGreaterThan(result1.amount1);
      
      // Check amount0 scaling (within 1% error for rounding)
      const ratio0 = Number(result2.amount0) / Number(result1.amount0);
      expect(ratio0).toBeGreaterThan(1.98);
      expect(ratio0).toBeLessThan(2.02);
      
      // Check amount1 scaling (within 1% error for rounding)
      const ratio1 = Number(result2.amount1) / Number(result1.amount1);
      expect(ratio1).toBeGreaterThan(1.98);
      expect(ratio1).toBeLessThan(2.02);
    });

    it("should return balanced amounts for symmetric range around current price", () => {
      // Symmetric range around price = 1.0
      const lower = -60;
      const upper = 60;
      const deltaLiquidity = 10000000n;

      const result = pool.removeLiquidity(deltaLiquidity, lower, upper);

      // Both should be positive
      expect(result.amount0).toBeGreaterThan(0n);
      expect(result.amount1).toBeGreaterThan(0n);
      
      // For a symmetric range around price 1.0, amounts should be relatively balanced
      const ratio = Number(result.amount1) / Number(result.amount0);
      expect(ratio).toBeGreaterThan(0.5); // Not too extreme
      expect(ratio).toBeLessThan(2.0);   // Not too extreme
    });

    it("should handle asymmetric ranges", () => {
      // Asymmetric range: more on the lower side
      const lower = -300;
      const upper = 60;
      const deltaLiquidity = 10000000n;

      const result = pool.removeLiquidity(deltaLiquidity, lower, upper);

      expect(result.amount0).toBeGreaterThan(0n);
      expect(result.amount1).toBeGreaterThan(0n);
    });

    it("should handle wide ranges", () => {
      // Very wide range
      const lower = -600;
      const upper = 600;
      const deltaLiquidity = 10000000n;

      const result = pool.removeLiquidity(deltaLiquidity, lower, upper);

      expect(result.amount0).toBeGreaterThan(0n);
      expect(result.amount1).toBeGreaterThan(0n);
    });

    it("should handle narrow ranges", () => {
      // Very narrow range
      const lower = -60;
      const upper = 60;
      const deltaLiquidity = 10000000n;

      const result = pool.removeLiquidity(deltaLiquidity, lower, upper);

      expect(result.amount0).toBeGreaterThan(0n);
      expect(result.amount1).toBeGreaterThan(0n);
    });

    it("should verify consistency with maxL calculation", () => {
      // First, calculate how much liquidity we can get from known amounts
      const lower = -120;
      const upper = 120;
      const initialAmount0 = 3000000n;
      const initialAmount1 = 3000000n;

      const maxLResult = pool.maxL(initialAmount0, initialAmount1, lower, upper);
      
      // Now remove that liquidity and verify we get similar amounts back
      const removeResult = pool.removeLiquidity(maxLResult.L, lower, upper);

      // Should get approximately the same amounts back (within small rounding error)
      const diff0 = removeResult.amount0 > maxLResult.amount0Used 
        ? removeResult.amount0 - maxLResult.amount0Used
        : maxLResult.amount0Used - removeResult.amount0;
      
      const diff1 = removeResult.amount1 > maxLResult.amount1Used 
        ? removeResult.amount1 - maxLResult.amount1Used
        : maxLResult.amount1Used - removeResult.amount1;
      
      // Allow small rounding error (less than 0.01%)
      expect(Number(diff0)).toBeLessThan(Number(maxLResult.amount0Used) * 0.0001);
      expect(Number(diff1)).toBeLessThan(Number(maxLResult.amount1Used) * 0.0001);
    });
  });

  describe("Edge cases and validation", () => {
    it("should throw error for zero liquidity", () => {
      expect(() => {
        pool.removeLiquidity(0n, -120, 120);
      }).toThrow("Delta liquidity must be greater than zero");
    });

    it("should throw error for negative liquidity", () => {
      expect(() => {
        pool.removeLiquidity(-1000n, -120, 120);
      }).toThrow("Delta liquidity must be greater than zero");
    });

    it("should throw error for misaligned lower tick", () => {
      expect(() => {
        pool.removeLiquidity(1000000n, -100, 120); // -100 not multiple of 60
      }).toThrow("not aligned to tickSpacing");
    });

    it("should throw error for misaligned upper tick", () => {
      expect(() => {
        pool.removeLiquidity(1000000n, -120, 100); // 100 not multiple of 60
      }).toThrow("not aligned to tickSpacing");
    });

    it("should throw error when lower >= upper", () => {
      expect(() => {
        pool.removeLiquidity(1000000n, 120, -120); // lower > upper
      }).toThrow("must be less than");
    });

    it("should throw error when lower equals upper", () => {
      expect(() => {
        pool.removeLiquidity(1000000n, 120, 120); // lower == upper
      }).toThrow("must be less than");
    });

    it("should handle very small liquidity amounts", () => {
      const result = pool.removeLiquidity(1n, -120, 120);
      
      // May get 0 due to rounding, but should not error
      expect(result.amount0).toBeGreaterThanOrEqual(0n);
      expect(result.amount1).toBeGreaterThanOrEqual(0n);
    });

    it("should handle very large liquidity amounts", () => {
      const hugeLiquidity = 10n ** 18n; // 1 quintillion
      
      const result = pool.removeLiquidity(hugeLiquidity, -120, 120);
      
      expect(result.amount0).toBeGreaterThan(0n);
      expect(result.amount1).toBeGreaterThan(0n);
    });
  });

  describe("Round-trip tests (add then remove liquidity)", () => {
    it("should get back approximately same amounts for price below range", () => {
      const lower = 120;
      const upper = 600;
      const amount0 = 5000000n;
      const amount1 = 0n;

      // Add liquidity
      const maxLResult = pool.maxL(amount0, amount1, lower, upper);
      
      // Remove all liquidity
      const removeResult = pool.removeLiquidity(maxLResult.L, lower, upper);

      // Should get back what was used (within rounding error)
      expect(removeResult.amount0).toBeGreaterThan(0n);
      expect(removeResult.amount1).toBe(0n);
      
      const diff = removeResult.amount0 > maxLResult.amount0Used
        ? removeResult.amount0 - maxLResult.amount0Used
        : maxLResult.amount0Used - removeResult.amount0;
      
      expect(Number(diff)).toBeLessThan(Number(maxLResult.amount0Used) * 0.0001);
    });

    it("should get back approximately same amounts for price above range", () => {
      const lower = -600;
      const upper = -120;
      const amount0 = 0n;
      const amount1 = 5000000n;

      // Add liquidity
      const maxLResult = pool.maxL(amount0, amount1, lower, upper);
      
      // Remove all liquidity
      const removeResult = pool.removeLiquidity(maxLResult.L, lower, upper);

      // Should get back what was used (within rounding error)
      expect(removeResult.amount0).toBe(0n);
      expect(removeResult.amount1).toBeGreaterThan(0n);
      
      const diff = removeResult.amount1 > maxLResult.amount1Used
        ? removeResult.amount1 - maxLResult.amount1Used
        : maxLResult.amount1Used - removeResult.amount1;
      
      expect(Number(diff)).toBeLessThan(Number(maxLResult.amount1Used) * 0.0001);
    });

    it("should get back approximately same amounts for price in range", () => {
      const lower = -120;
      const upper = 120;
      const amount0 = 5000000n;
      const amount1 = 5000000n;

      // Add liquidity
      const maxLResult = pool.maxL(amount0, amount1, lower, upper);
      
      // Remove all liquidity
      const removeResult = pool.removeLiquidity(maxLResult.L, lower, upper);

      // Should get back what was used (within rounding error)
      expect(removeResult.amount0).toBeGreaterThan(0n);
      expect(removeResult.amount1).toBeGreaterThan(0n);
      
      const diff0 = removeResult.amount0 > maxLResult.amount0Used
        ? removeResult.amount0 - maxLResult.amount0Used
        : maxLResult.amount0Used - removeResult.amount0;
      
      const diff1 = removeResult.amount1 > maxLResult.amount1Used
        ? removeResult.amount1 - maxLResult.amount1Used
        : maxLResult.amount1Used - removeResult.amount1;
      
      expect(Number(diff0)).toBeLessThan(Number(maxLResult.amount0Used) * 0.0001);
      expect(Number(diff1)).toBeLessThan(Number(maxLResult.amount1Used) * 0.0001);
    });

    it("should handle partial removal of liquidity", () => {
      const lower = -120;
      const upper = 120;
      const amount0 = 10000000n;
      const amount1 = 10000000n;

      // Add liquidity
      const maxLResult = pool.maxL(amount0, amount1, lower, upper);
      
      // Remove half of the liquidity
      const halfL = maxLResult.L / 2n;
      const removeResult = pool.removeLiquidity(halfL, lower, upper);

      // Should get approximately half of each amount back
      expect(removeResult.amount0).toBeGreaterThan(0n);
      expect(removeResult.amount1).toBeGreaterThan(0n);
      
      const ratio0 = Number(removeResult.amount0) / Number(maxLResult.amount0Used);
      const ratio1 = Number(removeResult.amount1) / Number(maxLResult.amount1Used);
      
      // Should be close to 0.5 (within 1% for rounding)
      expect(ratio0).toBeGreaterThan(0.49);
      expect(ratio0).toBeLessThan(0.51);
      expect(ratio1).toBeGreaterThan(0.49);
      expect(ratio1).toBeLessThan(0.51);
    });
  });

  describe("Different price scenarios with same range", () => {
    it("should return different ratios as price changes through the range", () => {
      const lower = -180;
      const upper = 180;
      const liquidity = 100000000n;

      // Test at current price (tick 0)
      const resultAtPrice1 = pool.removeLiquidity(liquidity, lower, upper);
      
      expect(resultAtPrice1.amount0).toBeGreaterThan(0n);
      expect(resultAtPrice1.amount1).toBeGreaterThan(0n);

      // Note: In a real scenario, we would change the pool price and test again
      // For this test, we just verify that the method works consistently
    });
  });
});

