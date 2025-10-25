import { describe, it, expect, beforeEach } from "bun:test";
import { PositionManager } from "../src/position_mgr";
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

describe("Fee Distribution", () => {
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
      sqrtPriceBefore: sqrtPriceX64,
      sqrtPriceAfter: sqrtPriceX64,
      feeAmount: 0n,
      liquidity: 1000000000n,
      tick: 0,
      reserveA: 1000000000000n,
      reserveB: 1000000000000n,
    });

    positionManager = new PositionManager(100000000n, 100000000n, pool);
  });

  describe("Basic Fee Distribution", () => {
    it("should distribute fees to single in-range position", () => {
      const posId = "test-position-1";
      positionManager.openPosition(posId, -120, 120);
      positionManager.addLiquidity(posId, 1000000n, 1000000n);
      
      const position = positionManager.getPosition(posId);
      expect(position.fee0).toBe(0n);
      expect(position.fee1).toBe(0n);
      
      // Simulate a swap event with fees
      const swapEvent: SwapEvent = {
        timestamp: Date.now(),
        poolId: "test-pool",
        amountIn: 1000000n,
        amountOut: 995000n,
        zeroForOne: true, // Swapping token0 for token1
        sqrtPriceBefore: pool.sqrtPriceX64,
      sqrtPriceAfter: pool.sqrtPriceX64,
        feeAmount: 5000n, // 0.5% fee
        liquidity: 1000000000n,
        tick: 0,
        reserveA: 1001000000000n,
        reserveB: 999005000000n,
      };
      
      positionManager.onSwapEvent(swapEvent);
      
      // Position should receive fees
      expect(position.fee0).toBeGreaterThan(0n);
      expect(position.accumulatedFee0).toBe(position.fee0);
      expect(position.fee1).toBe(0n); // No fee1 since swap was zeroForOne
    });

    it("should distribute fees proportionally to multiple positions", () => {
      // Create two positions with different liquidity
      const pos1 = "position-1";
      const pos2 = "position-2";
      
      positionManager.openPosition(pos1, -120, 120);
      positionManager.addLiquidity(pos1, 1000000n, 1000000n);
      
      positionManager.openPosition(pos2, -120, 120);
      positionManager.addLiquidity(pos2, 3000000n, 3000000n);
      
      const position1 = positionManager.getPosition(pos1);
      const position2 = positionManager.getPosition(pos2);
      
      const L1 = position1.L;
      const L2 = position2.L;
      
      // Simulate swap
      const swapEvent: SwapEvent = {
        timestamp: Date.now(),
        poolId: "test-pool",
        amountIn: 1000000n,
        amountOut: 995000n,
        zeroForOne: false, // Swapping token1 for token0
        sqrtPriceBefore: pool.sqrtPriceX64,
      sqrtPriceAfter: pool.sqrtPriceX64,
        feeAmount: 10000n, // Total fees
        liquidity: 1000000000n,
        tick: 0,
        reserveA: 999000000000n,
        reserveB: 1001000000000n,
      };
      
      positionManager.onSwapEvent(swapEvent);
      
      // Both positions should receive fees
      expect(position1.fee1).toBeGreaterThan(0n);
      expect(position2.fee1).toBeGreaterThan(0n);
      
      // Position2 should receive approximately 3x more fees (has 3x more liquidity)
      const ratio = Number(position2.fee1) / Number(position1.fee1);
      const expectedRatio = Number(L2) / Number(L1);
      
      // Allow 1% tolerance for rounding
      expect(ratio).toBeGreaterThan(expectedRatio * 0.99);
      expect(ratio).toBeLessThan(expectedRatio * 1.01);
    });

    it("should not distribute fees to out-of-range positions", () => {
      // Create one in-range and one out-of-range position
      const inRange = "in-range";
      const outOfRange = "out-of-range";
      
      positionManager.openPosition(inRange, -120, 120);
      positionManager.addLiquidity(inRange, 1000000n, 1000000n);
      
      // Position below current tick (current tick is 0)
      positionManager.openPosition(outOfRange, -300, -180);
      positionManager.addLiquidity(outOfRange, 1000000n, 0n);
      
      const positionIn = positionManager.getPosition(inRange);
      const positionOut = positionManager.getPosition(outOfRange);
      
      // Simulate swap at tick 0
      const swapEvent: SwapEvent = {
        timestamp: Date.now(),
        poolId: "test-pool",
        amountIn: 1000000n,
        amountOut: 995000n,
        zeroForOne: true,
        sqrtPriceBefore: pool.sqrtPriceX64,
      sqrtPriceAfter: pool.sqrtPriceX64,
        feeAmount: 5000n,
        liquidity: 1000000000n,
        tick: 0, // Current tick
        reserveA: 1001000000000n,
        reserveB: 999005000000n,
      };
      
      positionManager.onSwapEvent(swapEvent);
      
      // In-range position should receive fees
      expect(positionIn.fee0).toBeGreaterThan(0n);
      
      // Out-of-range position should NOT receive fees
      expect(positionOut.fee0).toBe(0n);
      expect(positionOut.fee1).toBe(0n);
    });
  });

  describe("Fee Accumulation Over Multiple Swaps", () => {
    it("should accumulate fees from multiple swap events", () => {
      const posId = "accumulate-position";
      positionManager.openPosition(posId, -120, 120);
      positionManager.addLiquidity(posId, 2000000n, 2000000n);
      
      const position = positionManager.getPosition(posId);
      
      // First swap
      const swap1: SwapEvent = {
        timestamp: Date.now(),
        poolId: "test-pool",
        amountIn: 500000n,
        amountOut: 497500n,
        zeroForOne: true,
        sqrtPriceBefore: pool.sqrtPriceX64,
      sqrtPriceAfter: pool.sqrtPriceX64,
        feeAmount: 2500n,
        liquidity: 1000000000n,
        tick: 0,
        reserveA: 1000500000000n,
        reserveB: 999502500000n,
      };
      
      positionManager.onSwapEvent(swap1);
      const feesAfterSwap1 = position.fee0;
      expect(feesAfterSwap1).toBeGreaterThan(0n);
      
      // Second swap
      const swap2: SwapEvent = {
        timestamp: Date.now() + 1000,
        poolId: "test-pool",
        amountIn: 500000n,
        amountOut: 497500n,
        zeroForOne: true,
        sqrtPriceBefore: pool.sqrtPriceX64,
      sqrtPriceAfter: pool.sqrtPriceX64,
        feeAmount: 2500n,
        liquidity: 1000000000n,
        tick: 0,
        reserveA: 1001000000000n,
        reserveB: 999005000000n,
      };
      
      positionManager.onSwapEvent(swap2);
      const feesAfterSwap2 = position.fee0;
      
      // Fees should have increased
      expect(feesAfterSwap2).toBeGreaterThan(feesAfterSwap1);
      
      // Should be approximately double (allowing for rounding)
      expect(feesAfterSwap2).toBeGreaterThanOrEqual(feesAfterSwap1 * 2n - 10n);
      expect(feesAfterSwap2).toBeLessThanOrEqual(feesAfterSwap1 * 2n + 10n);
    });

    it("should handle bidirectional swaps", () => {
      const posId = "bidirectional-position";
      positionManager.openPosition(posId, -120, 120);
      positionManager.addLiquidity(posId, 2000000n, 2000000n);
      
      const position = positionManager.getPosition(posId);
      
      // Swap token0 for token1
      const swapZeroForOne: SwapEvent = {
        timestamp: Date.now(),
        poolId: "test-pool",
        amountIn: 500000n,
        amountOut: 497500n,
        zeroForOne: true,
        sqrtPriceBefore: pool.sqrtPriceX64,
      sqrtPriceAfter: pool.sqrtPriceX64,
        feeAmount: 2500n,
        liquidity: 1000000000n,
        tick: 0,
        reserveA: 1000500000000n,
        reserveB: 999502500000n,
      };
      
      positionManager.onSwapEvent(swapZeroForOne);
      expect(position.fee0).toBeGreaterThan(0n);
      expect(position.fee1).toBe(0n);
      
      const fee0AfterFirst = position.fee0;
      
      // Swap token1 for token0
      const swapOneForZero: SwapEvent = {
        timestamp: Date.now() + 1000,
        poolId: "test-pool",
        amountIn: 500000n,
        amountOut: 497500n,
        zeroForOne: false,
        sqrtPriceBefore: pool.sqrtPriceX64,
      sqrtPriceAfter: pool.sqrtPriceX64,
        feeAmount: 2500n,
        liquidity: 1000000000n,
        tick: 0,
        reserveA: 999502500000n,
        reserveB: 1000500000000n,
      };
      
      positionManager.onSwapEvent(swapOneForZero);
      
      // Now should have both fee0 and fee1
      expect(position.fee0).toBe(fee0AfterFirst); // Unchanged
      expect(position.fee1).toBeGreaterThan(0n); // New fees
    });
  });

  describe("Fee Claiming", () => {
    it("should allow claiming fees", () => {
      const posId = "claim-position";
      positionManager.openPosition(posId, -120, 120);
      positionManager.addLiquidity(posId, 2000000n, 2000000n);
      
      // Generate some fees
      const swapEvent: SwapEvent = {
        timestamp: Date.now(),
        poolId: "test-pool",
        amountIn: 1000000n,
        amountOut: 995000n,
        zeroForOne: true,
        sqrtPriceBefore: pool.sqrtPriceX64,
      sqrtPriceAfter: pool.sqrtPriceX64,
        feeAmount: 5000n,
        liquidity: 1000000000n,
        tick: 0,
        reserveA: 1001000000000n,
        reserveB: 999005000000n,
      };
      
      positionManager.onSwapEvent(swapEvent);
      
      const position = positionManager.getPosition(posId);
      const earnedFee0 = position.fee0;
      
      expect(earnedFee0).toBeGreaterThan(0n);
      
      // Claim fees
      const claimed = positionManager.claimFee(posId);
      expect(claimed.fee0).toBe(earnedFee0);
      
      // Fees should be reset to 0
      expect(position.fee0).toBe(0n);
      
      // But accumulated fees should remain
      expect(position.accumulatedFee0).toBe(earnedFee0);
    });

    it("should maintain accumulated fees after claiming", () => {
      const posId = "accumulated-claim";
      positionManager.openPosition(posId, -120, 120);
      positionManager.addLiquidity(posId, 2000000n, 2000000n);
      
      // First swap
      const swap1: SwapEvent = {
        timestamp: Date.now(),
        poolId: "test-pool",
        amountIn: 500000n,
        amountOut: 497500n,
        zeroForOne: true,
        sqrtPriceBefore: pool.sqrtPriceX64,
      sqrtPriceAfter: pool.sqrtPriceX64,
        feeAmount: 2500n,
        liquidity: 1000000000n,
        tick: 0,
        reserveA: 1000500000000n,
        reserveB: 999502500000n,
      };
      
      positionManager.onSwapEvent(swap1);
      const position = positionManager.getPosition(posId);
      const firstFees = position.fee0;
      
      // Claim first round of fees
      positionManager.claimFee(posId);
      expect(position.fee0).toBe(0n);
      expect(position.accumulatedFee0).toBe(firstFees);
      
      // Second swap
      const swap2: SwapEvent = {
        timestamp: Date.now() + 1000,
        poolId: "test-pool",
        amountIn: 500000n,
        amountOut: 497500n,
        zeroForOne: true,
        sqrtPriceBefore: pool.sqrtPriceX64,
      sqrtPriceAfter: pool.sqrtPriceX64,
        feeAmount: 2500n,
        liquidity: 1000000000n,
        tick: 0,
        reserveA: 1001000000000n,
        reserveB: 999005000000n,
      };
      
      positionManager.onSwapEvent(swap2);
      const secondFees = position.fee0;
      
      // Claim second round
      positionManager.claimFee(posId);
      
      // Accumulated should be sum of both
      expect(position.accumulatedFee0).toBe(firstFees + secondFees);
    });
  });

  describe("Edge Cases", () => {
    it("should handle zero fees", () => {
      const posId = "zero-fee";
      positionManager.openPosition(posId, -120, 120);
      positionManager.addLiquidity(posId, 1000000n, 1000000n);
      
      const position = positionManager.getPosition(posId);
      
      // Swap with zero fees
      const swapEvent: SwapEvent = {
        timestamp: Date.now(),
        poolId: "test-pool",
        amountIn: 1000000n,
        amountOut: 1000000n,
        zeroForOne: true,
        sqrtPriceBefore: pool.sqrtPriceX64,
      sqrtPriceAfter: pool.sqrtPriceX64,
        feeAmount: 0n, // No fees
        liquidity: 1000000000n,
        tick: 0,
        reserveA: 1001000000000n,
        reserveB: 999000000000n,
      };
      
      positionManager.onSwapEvent(swapEvent);
      
      // Should not error, fees remain 0
      expect(position.fee0).toBe(0n);
      expect(position.fee1).toBe(0n);
    });

    it("should handle position with zero liquidity", () => {
      const posId = "zero-liquidity";
      positionManager.openPosition(posId, -120, 120);
      // Don't add any liquidity
      
      const position = positionManager.getPosition(posId);
      expect(position.L).toBe(0n);
      
      // Simulate swap
      const swapEvent: SwapEvent = {
        timestamp: Date.now(),
        poolId: "test-pool",
        amountIn: 1000000n,
        amountOut: 995000n,
        zeroForOne: true,
        sqrtPriceBefore: pool.sqrtPriceX64,
      sqrtPriceAfter: pool.sqrtPriceX64,
        feeAmount: 5000n,
        liquidity: 1000000000n,
        tick: 0,
        reserveA: 1001000000000n,
        reserveB: 999005000000n,
      };
      
      positionManager.onSwapEvent(swapEvent);
      
      // Should not receive any fees
      expect(position.fee0).toBe(0n);
      expect(position.fee1).toBe(0n);
    });

    it("should not distribute fees when no positions are active", () => {
      // Create position but close it
      const posId = "closed-position";
      positionManager.openPosition(posId, -120, 120);
      positionManager.addLiquidity(posId, 1000000n, 1000000n);
      positionManager.closePosition(posId);
      
      const position = positionManager.getPosition(posId);
      expect(position.isClosed).toBe(true);
      
      // Simulate swap
      const swapEvent: SwapEvent = {
        timestamp: Date.now(),
        poolId: "test-pool",
        amountIn: 1000000n,
        amountOut: 995000n,
        zeroForOne: true,
        sqrtPriceBefore: pool.sqrtPriceX64,
      sqrtPriceAfter: pool.sqrtPriceX64,
        feeAmount: 5000n,
        liquidity: 1000000000n,
        tick: 0,
        reserveA: 1001000000000n,
        reserveB: 999005000000n,
      };
      
      positionManager.onSwapEvent(swapEvent);
      
      // Closed position should not receive fees
      expect(position.fee0).toBe(0n);
    });
  });

  describe("Fee Distribution with Price Movement", () => {
    it("should handle fees when price moves position out of range", () => {
      const posId = "range-exit";
      positionManager.openPosition(posId, -120, 120);
      positionManager.addLiquidity(posId, 2000000n, 2000000n);
      
      const position = positionManager.getPosition(posId);
      
      // First swap in range
      const swap1: SwapEvent = {
        timestamp: Date.now(),
        poolId: "test-pool",
        amountIn: 500000n,
        amountOut: 497500n,
        zeroForOne: true,
        sqrtPriceBefore: pool.sqrtPriceX64,
        sqrtPriceAfter: pool.sqrtPriceX64,
        feeAmount: 2500n,
        liquidity: 1000000000n,
        tick: 0,
        reserveA: 1000500000000n,
        reserveB: 999502500000n,
      };
      
      positionManager.onSwapEvent(swap1);
      const feesInRange = position.fee0;
      expect(feesInRange).toBeGreaterThan(0n);
      
      // Second swap moves price out of range
      const newSqrtPriceX64 = BigInt(
        Math.floor(Math.sqrt(1.0001 ** 150) * Number(1n << 64n))
      );
      
      const swap2: SwapEvent = {
        timestamp: Date.now() + 1000,
        poolId: "test-pool",
        amountIn: 500000n,
        amountOut: 497500n,
        zeroForOne: true,
        sqrtPriceBefore: newSqrtPriceX64,
        sqrtPriceAfter: newSqrtPriceX64,
        feeAmount: 2500n,
        liquidity: 1000000000n,
        tick: 150, // Out of range (upper is 120)
        reserveA: 1001000000000n,
        reserveB: 999005000000n,
      };
      
      positionManager.onSwapEvent(swap2);
      
      // Fees should not increase (out of range)
      expect(position.fee0).toBe(feesInRange);
    });
  });

  describe("Accumulated Fee Distribution on Position Close", () => {
    it("should distribute accumulated fees when closing position", () => {
      const posId = "close-with-accumulated";
      positionManager.openPosition(posId, -120, 120);
      positionManager.addLiquidity(posId, 2000000n, 2000000n);
      
      const position = positionManager.getPosition(posId);
      
      // Create several small swaps that generate fees below threshold
      for (let i = 0; i < 5; i++) {
        const smallSwap: SwapEvent = {
          timestamp: Date.now() + i * 1000,
          poolId: "test-pool",
          amountIn: 10000n,
          amountOut: 9950n,
          zeroForOne: true,
          sqrtPriceBefore: pool.sqrtPriceX64,
          sqrtPriceAfter: pool.sqrtPriceX64,
          feeAmount: 100n, // Small fee (below 1000 threshold)
          liquidity: 1000000000n,
          tick: 0,
          reserveA: 1000010000000n,
          reserveB: 999990050000n,
        };
        
        positionManager.onSwapEvent(smallSwap);
      }
      
      // Fees should still be 0 (or minimal) because they're below threshold
      const feesBeforeClose = position.fee0;
      
      // Close position - should distribute accumulated fees
      const result = positionManager.closePosition(posId);
      
      // Should have received the accumulated fees
      expect(result.fee0).toBeGreaterThan(feesBeforeClose);
      expect(position.isClosed).toBe(true);
    });

    it("should not distribute accumulated fees to out-of-range position on close", () => {
      const inRangeId = "in-range-close";
      const outRangeId = "out-range-close";
      
      positionManager.openPosition(inRangeId, -120, 120);
      positionManager.addLiquidity(inRangeId, 2000000n, 2000000n);
      
      positionManager.openPosition(outRangeId, -300, -180);
      positionManager.addLiquidity(outRangeId, 2000000n, 0n);
      
      const inRangePos = positionManager.getPosition(inRangeId);
      const outRangePos = positionManager.getPosition(outRangeId);
      
      // Create small swaps that accumulate fees
      for (let i = 0; i < 3; i++) {
        const smallSwap: SwapEvent = {
          timestamp: Date.now() + i * 1000,
          poolId: "test-pool",
          amountIn: 10000n,
          amountOut: 9950n,
          zeroForOne: true,
          sqrtPriceBefore: pool.sqrtPriceX64,
          sqrtPriceAfter: pool.sqrtPriceX64,
          feeAmount: 200n, // Small fee
          liquidity: 1000000000n,
          tick: 0, // Current tick
          reserveA: 1000010000000n,
          reserveB: 999990050000n,
        };
        
        positionManager.onSwapEvent(smallSwap);
      }
      
      const outRangeFeesBeforeClose = outRangePos.fee0;
      
      // Close out-of-range position
      const result = positionManager.closePosition(outRangeId);
      
      // Out-of-range position should not receive accumulated fees
      expect(result.fee0).toBe(outRangeFeesBeforeClose);
      expect(result.fee0).toBe(0n);
    });

    it("should properly split accumulated fees among multiple positions on close", () => {
      const pos1Id = "multi-close-1";
      const pos2Id = "multi-close-2";
      
      positionManager.openPosition(pos1Id, -120, 120);
      positionManager.addLiquidity(pos1Id, 2000000n, 2000000n);
      
      positionManager.openPosition(pos2Id, -120, 120);
      positionManager.addLiquidity(pos2Id, 2000000n, 2000000n);
      
      const position1 = positionManager.getPosition(pos1Id);
      const position2 = positionManager.getPosition(pos2Id);
      
      const L1 = position1.L;
      const L2 = position2.L;
      
      // Create small swaps that accumulate fees
      for (let i = 0; i < 4; i++) {
        const smallSwap: SwapEvent = {
          timestamp: Date.now() + i * 1000,
          poolId: "test-pool",
          amountIn: 10000n,
          amountOut: 9950n,
          zeroForOne: true,
          sqrtPriceBefore: pool.sqrtPriceX64,
          sqrtPriceAfter: pool.sqrtPriceX64,
          feeAmount: 150n, // Small fee
          liquidity: 1000000000n,
          tick: 0,
          reserveA: 1000010000000n,
          reserveB: 999990050000n,
        };
        
        positionManager.onSwapEvent(smallSwap);
      }
      
      const fees1BeforeClose = position1.fee0;
      const fees2BeforeClose = position2.fee0;
      
      // Close first position - should get its share of accumulated fees
      const result1 = positionManager.closePosition(pos1Id);
      
      // Position 1 should have received some accumulated fees
      expect(result1.fee0).toBeGreaterThan(fees1BeforeClose);
      
      // Position 2 should still have the same fees (not closed yet)
      expect(position2.fee0).toBe(fees2BeforeClose);
      
      // Close second position
      const result2 = positionManager.closePosition(pos2Id);
      
      // Position 2 should also have received accumulated fees
      // Since they have equal liquidity, they should get equal shares
      expect(result2.fee0).toBeGreaterThan(fees2BeforeClose);
    });
  });
});

