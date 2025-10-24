import { describe, it, expect, beforeEach } from "bun:test";
import {
  SlippageEstimator,
  LinearSlippageEstimator,
  FixedSlippageProvider,
} from "../src/slippage_estimator";
import type { SwapEvent } from "../src/types";

describe("SlippageEstimator", () => {
  let estimator: SlippageEstimator;

  beforeEach(() => {
    estimator = new SlippageEstimator(0.001, 0.5); // 0.1% base, 50% max

    // Initialize with pool state
    // Using 6 decimal places: 1M tokens = 1,000,000 * 10^6 = 1,000,000,000,000
    const swapEvent: SwapEvent = {
      timestamp: Date.now(),
      poolId: "test-pool",
      amountIn: 0n,
      amountOut: 0n,
      zeroForOne: true,
      sqrtPriceBefore: 18446744073709551616n,
      sqrtPriceAfter: 18446744073709551616n, // ~1.0 price
      feeAmount: 0n,
      liquidity: 1000000000n,
      tick: 0,
      reserveA: 1000000000n, // 1000 tokens (with 6 decimals)
      reserveB: 1000000000n,
    };

    estimator.onSwapEvent(swapEvent);
  });

  describe("Basic Slippage Calculation", () => {
    it("should return base slippage for very small swaps", () => {
      const amountIn = 1000n; // 0.001 tokens - tiny swap
      const slippage = estimator.getSlippagePct(amountIn, true, 1.0);

      // Should be very close to base slippage
      expect(slippage).toBeGreaterThan(0.001);
      expect(slippage).toBeLessThan(0.0011); // Minimal price impact
    });

    it("should increase slippage for larger swaps", () => {
      const smallSwap = 1000000n; // 0.1% of reserves
      const largeSwap = 10000000n; // 1% of reserves

      const smallSlippage = estimator.getSlippagePct(smallSwap, true, 1.0);
      const largeSlippage = estimator.getSlippagePct(largeSwap, true, 1.0);

      expect(largeSlippage).toBeGreaterThan(smallSlippage);
    });

    it("should have diminishing impact (CLMM constant product model)", () => {
      const swap1x = 5000000n;   // 0.5% of reserve
      const swap2x = 10000000n;  // 1% of reserve
      const swap4x = 20000000n;  // 2% of reserve

      const slippage1x = estimator.getSlippagePct(swap1x, true, 1.0);
      const slippage2x = estimator.getSlippagePct(swap2x, true, 1.0);
      const slippage4x = estimator.getSlippagePct(swap4x, true, 1.0);

      // With constant product formula: impact = amountIn / (reserve + amountIn/2)
      // This gives diminishing returns, not quadratic
      // Larger swaps should have more impact, but sub-linearly
      const impact1x = slippage1x - 0.001;
      const impact2x = slippage2x - 0.001;
      const impact4x = slippage4x - 0.001;

      // 2x swap should have roughly 2x impact (slightly less due to diminishing returns)
      expect(impact2x / impact1x).toBeGreaterThan(1.9);
      expect(impact2x / impact1x).toBeLessThan(2.1);

      // 4x swap should have roughly 4x impact (slightly less)
      expect(impact4x / impact1x).toBeGreaterThan(3.8);
      expect(impact4x / impact1x).toBeLessThan(4.2);
    });
  });

  describe("Swap Direction", () => {
    it("should calculate slippage based on correct reserve for zeroForOne", () => {
      const amountIn = 10000000n; // 1% of reserve0

      const slippage = estimator.getSlippagePct(amountIn, true, 1.0);

      // Should be base + impact
      expect(slippage).toBeGreaterThan(0.001);
    });

    it("should calculate slippage based on correct reserve for oneForZero", () => {
      const amountIn = 10000000n; // 1% of reserve1

      const slippage = estimator.getSlippagePct(amountIn, false, 1.0);

      // Should be base + impact
      expect(slippage).toBeGreaterThan(0.001);
    });

    it("should handle asymmetric reserves correctly", () => {
      // Create pool with imbalanced reserves
      const asymmetricEvent: SwapEvent = {
        timestamp: Date.now(),
        poolId: "test-pool",
        amountIn: 0n,
        amountOut: 0n,
        zeroForOne: true,
        sqrtPriceBefore: 18446744073709551616n,
        sqrtPriceAfter: 18446744073709551616n,
        feeAmount: 0n,
        liquidity: 1000000000n,
        tick: 0,
        reserveA: 500000000n, // Half the reserves
        reserveB: 2000000000n, // Double the reserves
      };

      estimator.onSwapEvent(asymmetricEvent);

      const amountIn = 10000000n;

      // Same amount should have different slippage based on direction
      const slippage0to1 = estimator.getSlippagePct(amountIn, true, 1.0);
      const slippage1to0 = estimator.getSlippagePct(amountIn, false, 1.0);

      // Swapping from smaller reserve should have more slippage
      expect(slippage0to1).toBeGreaterThan(slippage1to0);
    });
  });

  describe("Constant Product Model", () => {
    it("should use CLMM constant product formula", () => {
      const amount = 10000000n; // 1% of reserves

      const slippage = estimator.getSlippagePct(amount, true, 1.0);

      // With constant product: impact = amountIn / (reserve + amountIn/2)
      // Expected: 10M / (1000M + 5M) = 10M / 1005M ≈ 0.00995 ≈ 1%
      // Total slippage = base (0.1%) + impact (1%) ≈ 1.1%
      expect(slippage).toBeGreaterThan(0.009); // At least 0.9%
      expect(slippage).toBeLessThan(0.012);    // At most 1.2%
    });

    it("should handle different pool sizes consistently", () => {
      // Small pool
      const smallPoolEvent: SwapEvent = {
        timestamp: Date.now(),
        poolId: "small-pool",
        amountIn: 0n,
        amountOut: 0n,
        zeroForOne: true,
        sqrtPriceBefore: 18446744073709551616n,
        sqrtPriceAfter: 18446744073709551616n,
        feeAmount: 0n,
        liquidity: 100000000n,
        tick: 0,
        reserveA: 100000000n,  // 100 tokens
        reserveB: 100000000n,
      };

      estimator.onSwapEvent(smallPoolEvent);
      const smallPoolSlippage = estimator.getSlippagePct(1000000n, true, 1.0); // 1% of reserve

      // Large pool (reset)
      const largePoolEvent: SwapEvent = {
        timestamp: Date.now(),
        poolId: "large-pool",
        amountIn: 0n,
        amountOut: 0n,
        zeroForOne: true,
        sqrtPriceBefore: 18446744073709551616n,
        sqrtPriceAfter: 18446744073709551616n,
        feeAmount: 0n,
        liquidity: 10000000000n,
        tick: 0,
        reserveA: 10000000000n,  // 10,000 tokens
        reserveB: 10000000000n,
      };

      estimator.onSwapEvent(largePoolEvent);
      const largePoolSlippage = estimator.getSlippagePct(100000000n, true, 1.0); // 1% of reserve

      // Same percentage of reserves should give similar slippage
      expect(Math.abs(smallPoolSlippage - largePoolSlippage)).toBeLessThan(0.0001);
    });
  });

  describe("Edge Cases", () => {
    it("should handle zero reserves gracefully", () => {
      const zeroReserveEstimator = new SlippageEstimator(0.001, 0.5);

      const slippage = zeroReserveEstimator.getSlippagePct(1000000n, true, 1.0);

      // Should return base slippage (no pool state)
      expect(slippage).toBe(0.001);
    });

    it("should cap slippage at max slippage", () => {
      const amountIn = 500000000n; // 50% of reserves - huge swap

      const slippage = estimator.getSlippagePct(amountIn, true, 1.0);

      // Should be capped at configured max (0.5 = 50%)
      expect(slippage).toBeLessThanOrEqual(0.5);
    });

    it("should handle very large swaps with cap", () => {
      const hugeSwap = 1000000000n; // Equal to entire reserve

      const slippage = estimator.getSlippagePct(hugeSwap, true, 1.0);

      // With constant product: 1000M / (1000M + 500M) = 0.667
      // Should be capped at max 0.5
      expect(slippage).toBeLessThanOrEqual(0.5);
    });

    it("should handle zero amount gracefully", () => {
      const slippage = estimator.getSlippagePct(0n, true, 1.0);
      expect(slippage).toBe(0);
    });

    it("should handle tiny liquidity with base slippage fallback", () => {
      const tinyReserveEvent: SwapEvent = {
        timestamp: Date.now(),
        poolId: "tiny-pool",
        amountIn: 0n,
        amountOut: 0n,
        zeroForOne: true,
        sqrtPriceBefore: 18446744073709551616n,
        sqrtPriceAfter: 18446744073709551616n,
        feeAmount: 0n,
        liquidity: 100n,  // Below MIN_LIQUIDITY threshold
        tick: 0,
        reserveA: 100n,
        reserveB: 100n,
      };

      estimator.onSwapEvent(tinyReserveEvent);
      const slippage = estimator.getSlippagePct(10n, true, 1.0);

      // Tiny liquidity (below threshold) returns base slippage
      expect(slippage).toBe(0.001);
    });
  });

  describe("Detailed Estimation", () => {
    it("should provide detailed breakdown via estimateSlippage", () => {
      const amountIn = 10000000n; // 1% of reserves

      const details = estimator.estimateSlippage(amountIn, true);

      expect(details.slippagePct).toBeGreaterThan(0.001);
      expect(details.baseSlippage).toBe(0.001);
      expect(details.priceImpact).toBeGreaterThan(0);
      expect(details.swapRatio).toBeCloseTo(0.01, 4); // 1%
      expect(details.slippagePct).toBe(
        details.baseSlippage + details.priceImpact
      );
    });

    it("should show zero price impact for very small swaps", () => {
      const tinySwap = 100n;

      const details = estimator.estimateSlippage(tinySwap, true);

      expect(details.priceImpact).toBeLessThan(0.0001);
      expect(details.slippagePct).toBeCloseTo(details.baseSlippage, 5);
    });
  });

  describe("State Tracking", () => {
    it("should update state on swap events", () => {
      const newEvent: SwapEvent = {
        timestamp: Date.now(),
        poolId: "test-pool",
        amountIn: 1000000n,
        amountOut: 995000n,
        zeroForOne: true,
        sqrtPriceBefore: 18446744073709551616n,
        sqrtPriceAfter: 18446744073709551616n,
        feeAmount: 5000n,
        liquidity: 2000000000n, // Changed
        tick: 0,
        reserveA: 1001000000n, // Changed
        reserveB: 999005000n, // Changed
      };

      estimator.onSwapEvent(newEvent);

      const state = estimator.getPoolState();

      expect(state.liquidity).toBe(2000000000n);
      expect(state.reserve0).toBe(1001000000n);
      expect(state.reserve1).toBe(999005000n);
    });
  });
});

describe("LinearSlippageEstimator", () => {
  let estimator: LinearSlippageEstimator;

  beforeEach(() => {
    estimator = new LinearSlippageEstimator(0.001, 0.1);

    const event: SwapEvent = {
      timestamp: Date.now(),
      poolId: "test-pool",
      amountIn: 0n,
      amountOut: 0n,
      zeroForOne: true,
      sqrtPriceBefore: 18446744073709551616n,
      sqrtPriceAfter: 18446744073709551616n,
      feeAmount: 0n,
      liquidity: 1000000000n,
      tick: 0,
      reserveA: 1000000000n,
      reserveB: 1000000000n,
    };

    estimator.onSwapEvent(event);
  });

  it("should have linear price impact", () => {
    const swap1x = 10000000n;
    const swap2x = 20000000n;

    const slippage1x = estimator.getSlippagePct(swap1x, true, 1.0);
    const slippage2x = estimator.getSlippagePct(swap2x, true, 1.0);

    const impact1x = slippage1x - 0.001;
    const impact2x = slippage2x - 0.001;

    // Linear: 2x size should have 2x impact
    expect(impact2x / impact1x).toBeGreaterThan(1.95);
    expect(impact2x / impact1x).toBeLessThan(2.05);
  });

  it("should return base slippage for small swaps", () => {
    const tinySwap = 100n;

    const slippage = estimator.getSlippagePct(tinySwap, true, 1.0);

    expect(slippage).toBeCloseTo(0.001, 5);
  });
});

describe("FixedSlippageProvider", () => {
  it("should always return fixed slippage", () => {
    const provider = new FixedSlippageProvider(0.005); // 0.5%

    expect(provider.getSlippagePct(1000n, true, 1.0)).toBe(0.005);
    expect(provider.getSlippagePct(1000000n, true, 1.0)).toBe(0.005);
    expect(provider.getSlippagePct(1000000000n, false, 1.0)).toBe(0.005);
  });

  it("should ignore swap events", () => {
    const provider = new FixedSlippageProvider(0.002);

    const event: SwapEvent = {
      timestamp: Date.now(),
      poolId: "test-pool",
      amountIn: 1000000n,
      amountOut: 995000n,
      zeroForOne: true,
      sqrtPriceBefore: 18446744073709551616n,
      sqrtPriceAfter: 18446744073709551616n,
      feeAmount: 5000n,
      liquidity: 1000000000n,
      tick: 0,
      reserveA: 1001000000n,
      reserveB: 999005000n,
    };

    provider.onSwapEvent(event);

    // Should still return fixed value
    expect(provider.getSlippagePct(1000000n, true, 1.0)).toBe(0.002);
  });
});

describe("Slippage Comparison", () => {
  it("should show different slippage models produce different results", () => {
    const quadratic = new SlippageEstimator(0.001, 1.0);
    const linear = new LinearSlippageEstimator(0.001, 0.1);
    const fixed = new FixedSlippageProvider(0.001);

    const event: SwapEvent = {
      timestamp: Date.now(),
      poolId: "test-pool",
      amountIn: 0n,
      amountOut: 0n,
      zeroForOne: true,
      sqrtPriceBefore: 18446744073709551616n,
      sqrtPriceAfter: 18446744073709551616n,
      feeAmount: 0n,
      liquidity: 1000000000n,
      tick: 0,
      reserveA: 1000000000n,
      reserveB: 1000000000n,
    };

    quadratic.onSwapEvent(event);
    linear.onSwapEvent(event);

    const largeSwap = 100000000n; // 10% of reserves - larger swap for more visible impact

    const quadraticSlippage = quadratic.getSlippagePct(largeSwap, true, 1.0);
    const linearSlippage = linear.getSlippagePct(largeSwap, true, 1.0);
    const fixedSlippage = fixed.getSlippagePct(largeSwap, true, 1.0);

    // Quadratic should be highest for large swaps
    expect(quadraticSlippage).toBeGreaterThanOrEqual(linearSlippage);
    expect(linearSlippage).toBeGreaterThan(fixedSlippage);

    // Verify visible differences
    expect(quadraticSlippage).toBeGreaterThan(0.01); // > 1%
    expect(linearSlippage).toBeGreaterThan(0.001); // > 0.1%

    console.log(`Large swap (10% of reserves):`);
    console.log(`  Quadratic: ${(quadraticSlippage * 100).toFixed(3)}%`);
    console.log(`  Linear: ${(linearSlippage * 100).toFixed(3)}%`);
    console.log(`  Fixed: ${(fixedSlippage * 100).toFixed(3)}%`);
  });
});

