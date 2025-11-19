import { describe, it, expect, test } from "bun:test";
import {
  LiquidityCalculator,
  LiquidityConstants,
  type AmountResult,
} from "../src/liquidity_calculator";
import type { TokenConfig } from "../src/virtual_position_mgr";

function priceToSqrtPriceX64(price: number): bigint {
  return BigInt(Math.floor(Math.sqrt(price) * Number(LiquidityConstants.Q64)));
}

function priceToTick(price: number): number {
  return Math.floor(Math.log(price) / Math.log(1.0001));
}

describe("LiquidityCalculator - maxLiquidity", () => {
  const tokenConfig: TokenConfig = {
    name0: "LBTC",
    name1: "wBTC",
    decimals0: 8,
    decimals1: 8,
  };

  const FeeRatePPM = 100; // 0.01%

  // Test cases: [currentPrice, lowerPrice, upperPrice, amount0, amount1, expectedMinLiquidity]
  const testCases = [
    {
      name: "Price in range with balanced amounts",
      currentPrice: 1.005,
      lowerPrice: 1.0,
      upperPrice: 1.2,
      amount0: 2,
      amount1: 2,
      expectedMinLiquidity: 2363384342n, // Perfectly balanced amounts
    },
    {
      name: "Price below range - only token0 useful",
      currentPrice: 0.9,
      lowerPrice: 1.0,
      upperPrice: 1.2,
      amount0: 5,
      amount1: 5,
      expectedMinLiquidity: 5739534991n, // Only token0 used
    },
    {
      name: "Price above range - only token1 useful",
      currentPrice: 1.3,
      lowerPrice: 1.0,
      upperPrice: 1.2,
      amount0: 5,
      amount1: 5,
      expectedMinLiquidity: 5239534991n, // Only token1 used (with some remainder)
    },
    {
      name: "Price at exact lower bound",
      currentPrice: 1.0,
      lowerPrice: 1.0,
      upperPrice: 1.2,
      amount0: 5,
      amount1: 5,
      expectedMinLiquidity: 5739534991n, // At lower boundary, only token0 used
    },
    {
      name: "Price at exact upper bound",
      currentPrice: 1.2,
      lowerPrice: 1.0,
      upperPrice: 1.2,
      amount0: 5,
      amount1: 5,
      expectedMinLiquidity: 5239534991n, // At upper boundary, only token1 used
    },
    {
      name: "Price far below range - only token0",
      currentPrice: 0.5,
      lowerPrice: 1.0,
      upperPrice: 1.2,
      amount0: 10,
      amount1: 0,
      expectedMinLiquidity: 5739534991n, // Perfect for out-of-range position
    },
    {
      name: "Price far above range - only token1",
      currentPrice: 2.0,
      lowerPrice: 1.0,
      upperPrice: 1.2,
      amount0: 0,
      amount1: 10,
      expectedMinLiquidity: 5239534991n, // Perfect for out-of-range position
    },
    {
      name: "Price below range with only token1 (wrong token)",
      currentPrice: 0.9,
      lowerPrice: 1.0,
      upperPrice: 1.2,
      amount0: 0,
      amount1: 10,
      expectedMinLiquidity: 5738961037n, // Swapped 50% token1 to token0
    },
    {
      name: "Price above range with only token0 (wrong token)",
      currentPrice: 1.3,
      lowerPrice: 1.0,
      upperPrice: 1.2,
      amount0: 10,
      amount1: 0,
      expectedMinLiquidity: 6129642914n, // Swapped 50% token0 to token1
    },
    {
      name: "Only token0 provided",
      currentPrice: 1.005,
      lowerPrice: 1.0,
      upperPrice: 1.2,
      amount0: 10,
      amount1: 0,
      expectedMinLiquidity: 5908460867n, // 50% swapped to token1
    },
    {
      name: "Only token1 provided",
      currentPrice: 1.005,
      lowerPrice: 1.0,
      upperPrice: 1.2,
      amount0: 0,
      amount1: 10,
      expectedMinLiquidity: 5290629858n, // 50% swapped to token0
    },
    {
      name: "Unbalanced amounts favoring token0",
      currentPrice: 1.005,
      lowerPrice: 1.0,
      upperPrice: 1.2,
      amount0: 10,
      amount1: 1,
      expectedMinLiquidity: 11816921735n, // 70% token1 unused, but <20% threshold so no swap
    },
    {
      name: "Unbalanced amounts favoring token1",
      currentPrice: 1.005,
      lowerPrice: 1.0,
      upperPrice: 1.2,
      amount0: 1,
      amount1: 10,
      expectedMinLiquidity: 8692127332n, // Swapped some token1 to token0
    },
    {
      name: "Price at midpoint of range",
      currentPrice: 1.1,
      lowerPrice: 1.0,
      upperPrice: 1.2,
      amount0: 5,
      amount1: 5,
      expectedMinLiquidity: 10244044240n, // Well balanced at midpoint
    },
    {
      name: "Very narrow range at lower bound",
      currentPrice: 1.005,
      lowerPrice: 1.0,
      upperPrice: 1.01,
      amount0: 10,
      amount1: 10,
      expectedMinLiquidity: 400499376557n, // Narrow range = high liquidity concentration
    },
    {
      name: "Very wide range",
      currentPrice: 1.0,
      lowerPrice: 0.5,
      upperPrice: 2.0,
      amount0: 10,
      amount1: 10,
      expectedMinLiquidity: 3414138713n, // Wide range = diluted liquidity
    },
  ];

  // Run each test case
  test.each(testCases)(
    "$name",
    ({
      currentPrice,
      lowerPrice,
      upperPrice,
      amount0,
      amount1,
      expectedMinLiquidity,
    }) => {
      const sqrtPriceX64 = priceToSqrtPriceX64(currentPrice);
      const lowerTick = priceToTick(lowerPrice);
      const upperTick = priceToTick(upperPrice);
      const amount0Wei = BigInt(amount0 * 10 ** tokenConfig.decimals0);
      const amount1Wei = BigInt(amount1 * 10 ** tokenConfig.decimals1);

      const result = LiquidityCalculator.maxLiquidity(
        sqrtPriceX64,
        FeeRatePPM,
        lowerTick,
        upperTick,
        amount0Wei,
        amount1Wei,
        tokenConfig
      );

      // Basic assertions
      expect(result.liquidity).toBeGreaterThanOrEqual(expectedMinLiquidity);
      expect(result.remain0).toBeGreaterThanOrEqual(0n);
      expect(result.remain1).toBeGreaterThanOrEqual(0n);
      expect(result.swapCost0).toBeGreaterThanOrEqual(0n);
      expect(result.swapFee1).toBeGreaterThanOrEqual(0n);
      expect(result.slippage0).toBeGreaterThanOrEqual(0n);
      expect(result.slippage1).toBeGreaterThanOrEqual(0n);

      // Log for debugging
      console.log(
        `\n[${currentPrice}, ${lowerPrice}, ${upperPrice}, ${amount0}, ${amount1}]:`
      );
      console.log(`  Liquidity: ${result.liquidity}`);
      console.log(`  Remain: [${result.remain0}, ${result.remain1}]`);
      console.log(`  Fees: [${result.swapCost0}, ${result.swapFee1}]`);
      console.log(`  Slippage: [${result.slippage0}, ${result.slippage1}]`);
    }
  );

  // Additional detailed test with specific expectations
  it("should handle balanced amounts at mid-range price correctly", () => {
    const currentPrice = 1.005;
    const lowerPrice = 1.0;
    const upperPrice = 1.2;
    const amount0 = 2;
    const amount1 = 2;

    const result = LiquidityCalculator.maxLiquidity(
      priceToSqrtPriceX64(currentPrice),
      FeeRatePPM,
      priceToTick(lowerPrice),
      priceToTick(upperPrice),
      BigInt(amount0 * 10 ** tokenConfig.decimals0),
      BigInt(amount1 * 10 ** tokenConfig.decimals1),
      tokenConfig
    );

    // Verify liquidity is produced
    expect(result.liquidity).toBeGreaterThan(0n);

    // Total used + remaining should approximately equal input
    const totalAmount0 = result.remain0 + result.swapCost0 + result.slippage0;
    const totalAmount1 = result.remain1 + result.swapFee1 + result.slippage1;

    // Allow some tolerance for rounding
    expect(totalAmount0).toBeLessThanOrEqual(
      BigInt(amount0 * 10 ** tokenConfig.decimals0)
    );
    expect(totalAmount1).toBeLessThanOrEqual(
      BigInt(amount1 * 10 ** tokenConfig.decimals1)
    );
  });
});

describe("LiquidityCalculator - estimatePositionFeesFromSwap", () => {
  const FeeRatePPM = 100; // 0.01%

  it("should allocate fees to an active position", () => {
    // Setup: Price 1.005, position range [1.0, 1.2]
    const sqrtPriceBefore = priceToSqrtPriceX64(1.006);
    const sqrtPriceAfter = priceToSqrtPriceX64(1.005); // Price decreases for token0->token1 swap
    const amountIn = 100000000n; // 1 token0 (8 decimals)
    const amountOut = 99500000n; // ~0.995 token1 (8 decimals)
    const zeroForOne = true; // Swapping token0 -> token1

    const positionLiquidity = 1000000000n;
    const positionTickLower = priceToTick(1.0);
    const positionTickUpper = priceToTick(1.2);

    const result = LiquidityCalculator.estimatePositionFeesFromSwap(
      sqrtPriceBefore,
      sqrtPriceAfter,
      amountIn,
      amountOut,
      zeroForOne,
      FeeRatePPM,
      positionLiquidity,
      positionTickLower,
      positionTickUpper
    );

    // Position should be active (price 1.006 is in range [1.0, 1.2])
    expect(result.isActive).toBe(true);

    // Should have positive fee0 (swap was token0 -> token1)
    expect(result.fee0).toBeGreaterThan(0n);
    expect(result.fee1).toBe(0n);

    // Total swap fee = 1 token0 * 0.01% = 0.0001 token0 = 10000 wei
    const totalFee = (amountIn * BigInt(FeeRatePPM)) / 1_000_000n;
    expect(totalFee).toBe(10000n);

    // Position should get a portion of this fee based on its liquidity share
    expect(result.fee0).toBeGreaterThan(0n);
    expect(result.fee0).toBeLessThanOrEqual(totalFee);

    console.log(`\nFee Allocation Test:`);
    console.log(`  Total Swap Fee: ${totalFee}`);
    console.log(`  Position Fee0: ${result.fee0}`);
    console.log(`  Position Fee1: ${result.fee1}`);
    console.log(`  Is Active: ${result.isActive}`);
  });

  it("should return zero fees for inactive position (price below range)", () => {
    const sqrtPriceBefore = priceToSqrtPriceX64(0.9);
    const sqrtPriceAfter = priceToSqrtPriceX64(0.89);
    const amountIn = 100000000n;
    const amountOut = 99500000n;
    const zeroForOne = true;

    const positionLiquidity = 1000000000n;
    const positionTickLower = priceToTick(1.0); // Position range [1.0, 1.2]
    const positionTickUpper = priceToTick(1.2);

    const result = LiquidityCalculator.estimatePositionFeesFromSwap(
      sqrtPriceBefore,
      sqrtPriceAfter,
      amountIn,
      amountOut,
      zeroForOne,
      FeeRatePPM,
      positionLiquidity,
      positionTickLower,
      positionTickUpper
    );

    // Position should NOT be active (price 0.89 is below range)
    expect(result.isActive).toBe(false);
    expect(result.fee0).toBe(0n);
    expect(result.fee1).toBe(0n);
  });

  it("should return zero fees for inactive position (price above range)", () => {
    const sqrtPriceBefore = priceToSqrtPriceX64(1.5);
    const sqrtPriceAfter = priceToSqrtPriceX64(1.51);
    const amountIn = 100000000n;
    const amountOut = 99500000n;
    const zeroForOne = false; // token1 -> token0

    const positionLiquidity = 1000000000n;
    const positionTickLower = priceToTick(1.0); // Position range [1.0, 1.2]
    const positionTickUpper = priceToTick(1.2);

    const result = LiquidityCalculator.estimatePositionFeesFromSwap(
      sqrtPriceBefore,
      sqrtPriceAfter,
      amountIn,
      amountOut,
      zeroForOne,
      FeeRatePPM,
      positionLiquidity,
      positionTickLower,
      positionTickUpper
    );

    // Position should NOT be active (price 1.51 is above range)
    expect(result.isActive).toBe(false);
    expect(result.fee0).toBe(0n);
    expect(result.fee1).toBe(0n);
  });

  it("should allocate token1 fees when swapping token1 -> token0", () => {
    const sqrtPriceBefore = priceToSqrtPriceX64(1.1);
    const sqrtPriceAfter = priceToSqrtPriceX64(1.11);
    const amountIn = 100000000n; // 1 token1 (8 decimals)
    const amountOut = 90000000n; // ~0.9 token0
    const zeroForOne = false; // Swapping token1 -> token0

    const positionLiquidity = 1000000000n;
    const positionTickLower = priceToTick(1.0);
    const positionTickUpper = priceToTick(1.2);

    const result = LiquidityCalculator.estimatePositionFeesFromSwap(
      sqrtPriceBefore,
      sqrtPriceAfter,
      amountIn,
      amountOut,
      zeroForOne,
      FeeRatePPM,
      positionLiquidity,
      positionTickLower,
      positionTickUpper
    );

    // Position should be active
    expect(result.isActive).toBe(true);

    // Should have positive fee1 (swap was token1 -> token0)
    expect(result.fee0).toBe(0n);
    expect(result.fee1).toBeGreaterThan(0n);

    console.log(`\nToken1 Fee Allocation:`);
    console.log(`  Position Fee0: ${result.fee0}`);
    console.log(`  Position Fee1: ${result.fee1}`);
  });

  it("should handle zero liquidity position", () => {
    const sqrtPriceBefore = priceToSqrtPriceX64(1.1);
    const sqrtPriceAfter = priceToSqrtPriceX64(1.11);
    const amountIn = 100000000n;
    const amountOut = 90000000n;
    const zeroForOne = false;

    const positionLiquidity = 0n; // Zero liquidity
    const positionTickLower = priceToTick(1.0);
    const positionTickUpper = priceToTick(1.2);

    const result = LiquidityCalculator.estimatePositionFeesFromSwap(
      sqrtPriceBefore,
      sqrtPriceAfter,
      amountIn,
      amountOut,
      zeroForOne,
      FeeRatePPM,
      positionLiquidity,
      positionTickLower,
      positionTickUpper
    );

    expect(result.isActive).toBe(false);
    expect(result.fee0).toBe(0n);
    expect(result.fee1).toBe(0n);
  });
});

describe("LiquidityCalculator - estimateMultiPositionFeesFromSwap", () => {
  const FeeRatePPM = 100; // 0.01%

  it("should allocate fees proportionally across multiple active positions", () => {
    const sqrtPriceBefore = priceToSqrtPriceX64(1.106);
    const sqrtPriceAfter = priceToSqrtPriceX64(1.105);
    const amountIn = 1000000000n; // 10 tokens
    const amountOut = 995000000n;
    const zeroForOne = true;

    const positions = [
      {
        liquidity: 1000000000n,
        tickLower: priceToTick(1.0),
        tickUpper: priceToTick(1.2),
      }, // Active
      {
        liquidity: 500000000n,
        tickLower: priceToTick(1.05),
        tickUpper: priceToTick(1.15),
      }, // Active
      {
        liquidity: 2000000000n,
        tickLower: priceToTick(0.8),
        tickUpper: priceToTick(1.0),
      }, // Inactive
    ];

    const results = LiquidityCalculator.estimateMultiPositionFeesFromSwap(
      sqrtPriceBefore,
      sqrtPriceAfter,
      amountIn,
      amountOut,
      zeroForOne,
      FeeRatePPM,
      positions
    );

    // Total fee = 10 tokens * 0.01% = 0.01 tokens = 100000 wei
    const totalFee = (amountIn * BigInt(FeeRatePPM)) / 1_000_000n;
    expect(totalFee).toBe(100000n);

    // Position 0 and 1 should be active
    expect(results[0].isActive).toBe(true);
    expect(results[0].fee0).toBeGreaterThan(0n);
    expect(results[1].isActive).toBe(true);
    expect(results[1].fee0).toBeGreaterThan(0n);

    // Position 2 should be inactive (price is above its range)
    expect(results[2].isActive).toBe(false);
    expect(results[2].fee0).toBe(0n);

    // Position 0 should get 2x more fees than Position 1 (2:1 liquidity ratio)
    const ratio = Number(results[0].fee0) / Number(results[1].fee0);
    expect(ratio).toBeCloseTo(2.0, 0.1);

    // Total allocated fees should not exceed total swap fees
    const totalAllocated = results[0].fee0 + results[1].fee0 + results[2].fee0;
    expect(totalAllocated).toBeLessThanOrEqual(totalFee);

    console.log(`\nMulti-Position Fee Allocation:`);
    console.log(`  Total Swap Fee: ${totalFee}`);
    console.log(
      `  Position 0 (1B liq): ${results[0].fee0} (active: ${results[0].isActive})`
    );
    console.log(
      `  Position 1 (500M liq): ${results[1].fee0} (active: ${results[1].isActive})`
    );
    console.log(
      `  Position 2 (2B liq): ${results[2].fee0} (active: ${results[2].isActive})`
    );
    console.log(`  Total Allocated: ${totalAllocated}`);
  });

  it("should cap allocation when position liquidity exceeds pool liquidity", () => {
    const sqrtPriceBefore = priceToSqrtPriceX64(1.006);
    const sqrtPriceAfter = priceToSqrtPriceX64(1.005);
    const amountIn = 100000000n; // 1 token
    const amountOut = 99500000n;
    const zeroForOne = true;

    // Create positions with huge liquidity (likely more than pool)
    const positions = [
      {
        liquidity: 100000000000n,
        tickLower: priceToTick(1.0),
        tickUpper: priceToTick(1.2),
      },
      {
        liquidity: 200000000000n,
        tickLower: priceToTick(1.0),
        tickUpper: priceToTick(1.2),
      },
      {
        liquidity: 300000000000n,
        tickLower: priceToTick(1.0),
        tickUpper: priceToTick(1.2),
      },
    ];

    const results = LiquidityCalculator.estimateMultiPositionFeesFromSwap(
      sqrtPriceBefore,
      sqrtPriceAfter,
      amountIn,
      amountOut,
      zeroForOne,
      FeeRatePPM,
      positions
    );

    const totalFee = (amountIn * BigInt(FeeRatePPM)) / 1_000_000n;
    expect(totalFee).toBe(10000n);

    // All positions should be active
    expect(results[0].isActive).toBe(true);
    expect(results[1].isActive).toBe(true);
    expect(results[2].isActive).toBe(true);

    // Total allocated should NOT exceed total fee (capped at 100%)
    const totalAllocated = results[0].fee0 + results[1].fee0 + results[2].fee0;
    expect(totalAllocated).toBeLessThanOrEqual(totalFee);

    // Fees should still be allocated proportionally (1:2:3 ratio)
    const ratio01 = Number(results[1].fee0) / Number(results[0].fee0);
    const ratio02 = Number(results[2].fee0) / Number(results[0].fee0);
    expect(ratio01).toBeCloseTo(2.0, 0.1);
    expect(ratio02).toBeCloseTo(3.0, 0.1);

    console.log(`\nCapped Allocation Test:`);
    console.log(`  Total Swap Fee: ${totalFee}`);
    console.log(`  Position 0: ${results[0].fee0}`);
    console.log(`  Position 1: ${results[1].fee0}`);
    console.log(`  Position 2: ${results[2].fee0}`);
    console.log(`  Total Allocated: ${totalAllocated}`);
    console.log(
      `  Allocation %: ${(
        (Number(totalAllocated) / Number(totalFee)) *
        100
      ).toFixed(2)}%`
    );
  });

  it("should handle all positions inactive", () => {
    const sqrtPriceBefore = priceToSqrtPriceX64(0.9);
    const sqrtPriceAfter = priceToSqrtPriceX64(0.89);
    const amountIn = 100000000n;
    const amountOut = 99500000n;
    const zeroForOne = true;

    const positions = [
      {
        liquidity: 1000000000n,
        tickLower: priceToTick(1.0),
        tickUpper: priceToTick(1.2),
      },
      {
        liquidity: 500000000n,
        tickLower: priceToTick(1.05),
        tickUpper: priceToTick(1.15),
      },
    ];

    const results = LiquidityCalculator.estimateMultiPositionFeesFromSwap(
      sqrtPriceBefore,
      sqrtPriceAfter,
      amountIn,
      amountOut,
      zeroForOne,
      FeeRatePPM,
      positions
    );

    // All positions inactive (price 0.89 is below all ranges)
    expect(results[0].isActive).toBe(false);
    expect(results[0].fee0).toBe(0n);
    expect(results[1].isActive).toBe(false);
    expect(results[1].fee0).toBe(0n);
  });

  it("should handle empty positions array", () => {
    const sqrtPriceBefore = priceToSqrtPriceX64(1.1);
    const sqrtPriceAfter = priceToSqrtPriceX64(1.09);
    const amountIn = 100000000n;
    const amountOut = 99500000n;
    const zeroForOne = true;

    const results = LiquidityCalculator.estimateMultiPositionFeesFromSwap(
      sqrtPriceBefore,
      sqrtPriceAfter,
      amountIn,
      amountOut,
      zeroForOne,
      FeeRatePPM,
      []
    );

    expect(results).toHaveLength(0);
  });
});

describe("LiquidityCalculator - estimateMultiPositionFeesFromSwapWithPoolLiquidity", () => {
  const FeeRatePPM = 100; // 0.01%

  const testCases = [
    {
      name: "Normal allocation with mixed active/inactive positions",
      poolLiquidity: 20000000000n,
      swapPrice: 1.105,
      amountIn: 1000000000n,
      zeroForOne: true,
      positions: [
        { liquidity: 1000000000n, lowerPrice: 1.0, upperPrice: 1.2 }, // Active
        { liquidity: 500000000n, lowerPrice: 1.05, upperPrice: 1.15 }, // Active
        { liquidity: 2000000000n, lowerPrice: 0.8, upperPrice: 1.0 }, // Inactive
      ],
      expectedActiveCount: 2,
      expectedRatio: 2.0, // Position 0 / Position 1
      shouldCapAt100: false,
    },
    {
      name: "Position liquidity exceeds pool liquidity (capped)",
      poolLiquidity: 1000000000n,
      swapPrice: 1.1,
      amountIn: 100000000n,
      zeroForOne: true,
      positions: [
        { liquidity: 800000000n, lowerPrice: 1.0, upperPrice: 1.2 },
        { liquidity: 400000000n, lowerPrice: 1.0, upperPrice: 1.2 },
      ],
      expectedActiveCount: 2,
      expectedRatio: 2.0,
      shouldCapAt100: true,
    },
    {
      name: "All positions inactive (price below range)",
      poolLiquidity: 10000000000n,
      swapPrice: 0.5,
      amountIn: 100000000n,
      zeroForOne: true,
      positions: [
        { liquidity: 1000000000n, lowerPrice: 1.0, upperPrice: 1.2 },
        { liquidity: 500000000n, lowerPrice: 1.05, upperPrice: 1.15 },
      ],
      expectedActiveCount: 0,
      expectedRatio: null,
      shouldCapAt100: false,
    },
    {
      name: "All positions inactive (price above range)",
      poolLiquidity: 10000000000n,
      swapPrice: 2.0,
      amountIn: 100000000n,
      zeroForOne: false,
      positions: [
        { liquidity: 1000000000n, lowerPrice: 1.0, upperPrice: 1.2 },
        { liquidity: 500000000n, lowerPrice: 1.05, upperPrice: 1.15 },
      ],
      expectedActiveCount: 0,
      expectedRatio: null,
      shouldCapAt100: false,
    },
    {
      name: "Single active position at exact tick boundary",
      poolLiquidity: 5000000000n,
      swapPrice: 1.0,
      amountIn: 100000000n,
      zeroForOne: false,
      positions: [
        { liquidity: 1000000000n, lowerPrice: 1.0, upperPrice: 1.2 }, // Active (inclusive lower)
        { liquidity: 500000000n, lowerPrice: 0.8, upperPrice: 1.0 }, // Inactive (exclusive upper)
      ],
      expectedActiveCount: 1,
      expectedRatio: null,
      shouldCapAt100: false,
    },
    {
      name: "Token1 fees (zeroForOne=false)",
      poolLiquidity: 15000000000n,
      swapPrice: 1.1,
      amountIn: 100000000n,
      zeroForOne: false,
      positions: [
        { liquidity: 1000000000n, lowerPrice: 1.0, upperPrice: 1.2 },
        { liquidity: 2000000000n, lowerPrice: 1.05, upperPrice: 1.15 },
      ],
      expectedActiveCount: 2,
      expectedRatio: 0.5, // Position 0 / Position 1 (reversed)
      shouldCapAt100: false,
    },
    {
      name: "Very small position relative to pool",
      poolLiquidity: 100000000000n, // 100B pool
      swapPrice: 1.1,
      amountIn: 1000000000n,
      zeroForOne: true,
      positions: [
        { liquidity: 10000000n, lowerPrice: 1.0, upperPrice: 1.2 }, // 0.01% of pool
      ],
      expectedActiveCount: 1,
      expectedRatio: null,
      shouldCapAt100: false,
    },
    {
      name: "Empty positions array",
      poolLiquidity: 10000000000n,
      swapPrice: 1.1,
      amountIn: 100000000n,
      zeroForOne: true,
      positions: [],
      expectedActiveCount: 0,
      expectedRatio: null,
      shouldCapAt100: false,
    },
  ];

  test.each(testCases)(
    "$name",
    ({
      poolLiquidity,
      swapPrice,
      amountIn,
      zeroForOne,
      positions,
      expectedActiveCount,
      expectedRatio,
      shouldCapAt100,
    }) => {
      const swapTick = priceToTick(swapPrice);
      const positionsWithTicks = positions.map((p) => ({
        liquidity: p.liquidity,
        tickLower: priceToTick(p.lowerPrice),
        tickUpper: priceToTick(p.upperPrice),
      }));

      const results =
        LiquidityCalculator.estimateMultiPositionFeesFromSwapWithPoolLiquidity(
          poolLiquidity,
          swapTick,
          amountIn,
          zeroForOne,
          FeeRatePPM,
          positionsWithTicks
        );

      const totalFee = (amountIn * BigInt(FeeRatePPM)) / 1_000_000n;

      // Check active count
      const activeCount = results.filter((r) => r.isActive).length;
      expect(activeCount).toBe(expectedActiveCount);

      // Check fees are in correct token
      results.forEach((result, i) => {
        if (result.isActive) {
          if (zeroForOne) {
            expect(result.fee0).toBeGreaterThan(0n);
            expect(result.fee1).toBe(0n);
          } else {
            expect(result.fee0).toBe(0n);
            expect(result.fee1).toBeGreaterThan(0n);
          }
        } else {
          expect(result.fee0).toBe(0n);
          expect(result.fee1).toBe(0n);
        }
      });

      // Check total allocation doesn't exceed total fees
      const totalAllocated = results.reduce(
        (sum, r) => sum + r.fee0 + r.fee1,
        0n
      );
      expect(totalAllocated).toBeLessThanOrEqual(totalFee);

      // Check capping behavior
      if (shouldCapAt100) {
        // When capped, should get close to 100%
        const allocationPercent =
          (Number(totalAllocated) / Number(totalFee)) * 100;
        expect(allocationPercent).toBeGreaterThan(95); // Allow some rounding
      }

      // Check liquidity ratio if specified
      if (expectedRatio !== null && results.length >= 2) {
        const activeResults = results.filter((r) => r.isActive);
        if (activeResults.length >= 2) {
          const fee0 = activeResults[0].fee0 + activeResults[0].fee1;
          const fee1 = activeResults[1].fee0 + activeResults[1].fee1;
          if (fee1 > 0n) {
            const ratio = Number(fee0) / Number(fee1);
            expect(ratio).toBeCloseTo(expectedRatio, 0.1);
          }
        }
      }

      // Log for debugging
      console.log(
        `\n[${swapPrice}, pool=${poolLiquidity}, dir=${
          zeroForOne ? "0→1" : "1→0"
        }]:`
      );
      console.log(`  Total Fee: ${totalFee}`);
      results.forEach((r, i) => {
        const fee = r.fee0 + r.fee1;
        console.log(
          `  Position ${i}: ${fee} (active: ${r.isActive}, liq: ${
            positions[i]?.liquidity || "N/A"
          })`
        );
      });
      console.log(`  Total Allocated: ${totalAllocated}`);
      if (totalFee > 0n) {
        console.log(
          `  Allocation %: ${(
            (Number(totalAllocated) / Number(totalFee)) *
            100
          ).toFixed(4)}%`
        );
      }
    }
  );
});
