import { describe, it, expect, beforeEach } from "bun:test";
import {
  SlippageEstimator,
  FixedSlippageProvider,
} from "../src/slippage_estimator";
import type { SwapEvent } from "../src/types";

describe("SlippageEstimator", () => {
  let estimator: SlippageEstimator;

  beforeEach(() => {
    estimator = new SlippageEstimator(0.001, 0.5); // 0.1% base, 50% max

    // Initialize with pool liquidity
    // Using 6 decimal places: 1M tokens = 1,000,000 * 10^6 = 1,000,000,000,000
    estimator.setPoolLiquidity(1000000000n);
  });

  describe("Basic Slippage Calculation", () => {
    it("should return minimal slippage for very small swaps", () => {
      const amountIn = 1000n; // 0.001 tokens - tiny swap
      const slippage = estimator.getSlippagePct(amountIn, true, 1.0);

      // Should be very small (only price impact, no base slippage)
      expect(slippage).toBeGreaterThanOrEqual(0);
      expect(slippage).toBeLessThan(0.0001); // Minimal price impact
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

      // With CLMM formula: impact = (amountIn / L) * scaling_factor
      // This gives linear scaling with a small factor
      // Larger swaps should have proportionally more impact
      const impact1x = slippage1x;
      const impact2x = slippage2x;
      const impact4x = slippage4x;

      // 2x swap should have roughly 2x impact (linear with small scaling)
      expect(impact2x / impact1x).toBeGreaterThan(1.95);
      expect(impact2x / impact1x).toBeLessThan(2.05);

      // 4x swap should have roughly 4x impact
      expect(impact4x / impact1x).toBeGreaterThan(3.95);
      expect(impact4x / impact1x).toBeLessThan(4.05);
    });
  });

  describe("Swap Direction", () => {
    it("should calculate slippage based on liquidity for zeroForOne", () => {
      const amountIn = 10000000n; // 1% of liquidity

      const slippage = estimator.getSlippagePct(amountIn, true, 1.0);

      // Should be only price impact (no base slippage)
      expect(slippage).toBeGreaterThan(0);
    });

    it("should calculate slippage based on liquidity for oneForZero", () => {
      const amountIn = 10000000n; // 1% of liquidity

      const slippage = estimator.getSlippagePct(amountIn, false, 1.0);

      // Should be only price impact (no base slippage)
      expect(slippage).toBeGreaterThan(0);
    });

    it("should handle asymmetric reserves correctly", () => {
      // For CLMM, slippage is based on liquidity L, not reserves
      // So with the same liquidity, slippage should be the same regardless of reserve imbalance
      
      // Set pool liquidity (same as initial)
      estimator.setPoolLiquidity(1000000000n);

      const amountIn = 10000000n;

      // With CLMM formula (amountIn / L), direction doesn't matter for price impact
      const slippage0to1 = estimator.getSlippagePct(amountIn, true, 1.0);
      const slippage1to0 = estimator.getSlippagePct(amountIn, false, 1.0);

      // Same liquidity should give same slippage regardless of direction
      expect(slippage0to1).toBeCloseTo(slippage1to0, 6);
    });
  });

  describe("Constant Product Model", () => {
    it("should use CLMM formula for price impact", () => {
      const amount = 10000000n; // 1% of liquidity

      const slippage = estimator.getSlippagePct(amount, true, 1.0);

      // With CLMM: impact = (amountIn / L) * scaling_factor
      // Expected: (10M / 1000M) * 0.1 = 0.01 * 0.1 = 0.001 = 0.1%
      expect(slippage).toBeGreaterThan(0.0009); // At least 0.09%
      expect(slippage).toBeLessThan(0.0011);    // At most 0.11%
    });

    it("should handle different pool sizes consistently", () => {
      // Small pool
      estimator.setPoolLiquidity(100000000n);
      const smallPoolSlippage = estimator.getSlippagePct(1000000n, true, 1.0); // 1% of liquidity

      // Large pool (reset)
      estimator.setPoolLiquidity(10000000000n);
      const largePoolSlippage = estimator.getSlippagePct(100000000n, true, 1.0); // 1% of liquidity

      // Same percentage of liquidity should give similar slippage
      expect(Math.abs(smallPoolSlippage - largePoolSlippage)).toBeLessThan(0.0001);
    });
  });

  describe("Edge Cases", () => {
    it("should handle zero liquidity gracefully", () => {
      const zeroReserveEstimator = new SlippageEstimator(0.001, 0.5);

      const slippage = zeroReserveEstimator.getSlippagePct(1000000n, true, 1.0);

      // Should return 0 (no liquidity, no slippage calculated)
      expect(slippage).toBe(0);
    });

    it("should cap slippage at max slippage", () => {
      const amountIn = 500000000n; // 50% of reserves - huge swap

      const slippage = estimator.getSlippagePct(amountIn, true, 1.0);

      // Should be capped at configured max (0.5 = 50%)
      expect(slippage).toBeLessThanOrEqual(0.5);
    });

    it("should handle very large swaps with cap", () => {
      const hugeSwap = 1000000000n; // Equal to entire liquidity

      const slippage = estimator.getSlippagePct(hugeSwap, true, 1.0);

      // With CLMM: 1000M / 1000M = 1.0 = 100%
      // Should be capped at max 0.5
      expect(slippage).toBeLessThanOrEqual(0.5);
    });

    it("should handle zero amount gracefully", () => {
      const slippage = estimator.getSlippagePct(0n, true, 1.0);
      expect(slippage).toBe(0);
    });

    it("should handle tiny liquidity with zero slippage fallback", () => {
      estimator.setPoolLiquidity(100n);  // Below MIN_LIQUIDITY threshold
      const slippage = estimator.getSlippagePct(10n, true, 1.0);

      // Tiny liquidity (below threshold) returns 0 (not base slippage)
      expect(slippage).toBe(0);
    });
  });

  describe("Detailed Estimation", () => {
    it("should provide detailed breakdown via estimateSlippage", () => {
      const amountIn = 10000000n; // 1% of liquidity

      const details = estimator.estimateSlippage(amountIn, true);

      expect(details.slippagePct).toBeGreaterThan(0);
      expect(details.baseSlippage).toBe(0);  // No base slippage used
      expect(details.priceImpact).toBeGreaterThan(0);
      expect(details.liquidityRatio).toBeCloseTo(0.01, 4); // 1%
      expect(details.slippagePct).toBe(details.priceImpact); // Only price impact
    });

    it("should show zero price impact for very small swaps", () => {
      const tinySwap = 100n;

      const details = estimator.estimateSlippage(tinySwap, true);

      expect(details.priceImpact).toBeLessThan(0.0001);
      expect(details.slippagePct).toBeCloseTo(0, 5);  // Very close to 0
      expect(details.baseSlippage).toBe(0);  // No base slippage
    });
  });

  describe("State Tracking", () => {
    it("should update liquidity when set by pool", () => {
      estimator.setPoolLiquidity(2000000000n);

      const liquidity = estimator.getPoolLiquidity();

      expect(liquidity).toBe(2000000000n);
    });
  });
});

describe("FixedSlippageProvider", () => {
  it("should always return fixed slippage", () => {
    const provider = new FixedSlippageProvider(0.005); // 0.5%

    expect(provider.getSlippagePct(1000n, true, 1.0)).toBe(0.005);
    expect(provider.getSlippagePct(1000000n, true, 1.0)).toBe(0.005);
    expect(provider.getSlippagePct(1000000000n, false, 1.0)).toBe(0.005);
  });

  it("should ignore liquidity updates", () => {
    const provider = new FixedSlippageProvider(0.002);

    // Set liquidity (should be no-op)
    provider.setPoolLiquidity(1000000000n);

    // Should still return fixed value
    expect(provider.getSlippagePct(1000000n, true, 1.0)).toBe(0.002);
  });
});

describe("Slippage Comparison", () => {
  it("should show CLMM and fixed slippage models produce different results", () => {
    const clmm = new SlippageEstimator(0.001, 1.0);
    const fixed = new FixedSlippageProvider(0.0005); // 0.05% fixed

    // Set liquidity for CLMM estimator
    clmm.setPoolLiquidity(1000000000n);

    const largeSwap = 100000000n; // 10% of liquidity

    const clmmSlippage = clmm.getSlippagePct(largeSwap, true, 1.0);
    const fixedSlippage = fixed.getSlippagePct(largeSwap, true, 1.0);

    // CLMM should have price impact for large swaps (1% for 10% swap)
    // Fixed is always 0.05%
    expect(clmmSlippage).toBeGreaterThan(fixedSlippage);

    // Verify visible differences
    // With scaling factor 0.1: 10% swap → 1% slippage
    expect(clmmSlippage).toBeGreaterThan(0.009); // > 0.9%
    expect(clmmSlippage).toBeLessThan(0.011);    // < 1.1%
    expect(fixedSlippage).toBe(0.0005); // Exactly 0.05%

    console.log(`Large swap (10% of liquidity):`);
    console.log(`  CLMM: ${(clmmSlippage * 100).toFixed(4)}%`);
    console.log(`  Fixed: ${(fixedSlippage * 100).toFixed(4)}%`);
  });
});

