/**
 * Pool-CLMM Adapter
 *
 * This adapter allows Pool to use CLMM's core swap logic while maintaining
 * Pool's bigint-based interface for event replay and backtesting.
 *
 * Key responsibilities:
 * - Convert between bigint (Pool) and Decimal (CLMM)
 * - Delegate swap calculations to CLMM
 * - Sync state between Pool and CLMM
 */

import { CLMM, D, type PoolConfig, type SwapArgs } from "./clmm";
import Decimal from "decimal.js";

export class PoolCLMMAdapter {
  private clmm: CLMM;

  constructor(feeRate: number, tickSpacing: number, sqrtPriceX64: bigint) {
    const config: PoolConfig = {
      feeRate,
      tickSpacing,
      sqrtPriceX64,
    };
    this.clmm = CLMM.make(config);
  }

  /**
   * Sync Pool state to CLMM
   * Call this before using CLMM for calculations
   */
  syncFromPool(pool: {
    sqrtPriceX64: bigint;
    tickCurrent: number;
    liquidity: bigint;
    feeGrowthGlobal0X64: bigint;
    feeGrowthGlobal1X64: bigint;
    ticks: Map<
      number,
      {
        liquidityNet: bigint;
        liquidityGross: bigint;
        feeGrowthOutside0X64: bigint;
        feeGrowthOutside1X64: bigint;
      }
    >;
  }): void {
    this.clmm.sqrtPriceX64 = pool.sqrtPriceX64;
    this.clmm.currentTick = pool.tickCurrent;
    this.clmm.liquidity = D(pool.liquidity.toString());

    // Note: CLMM uses X128, Pool uses X64
    // We need to scale when syncing
    const scaleFactor = 2n ** 64n;
    this.clmm.feeGrowthGlobal0X128 = pool.feeGrowthGlobal0X64 * scaleFactor;
    this.clmm.feeGrowthGlobal1X128 = pool.feeGrowthGlobal1X64 * scaleFactor;

    // Sync ticks
    this.clmm.ticks.clear();
    for (const [tickIndex, tickData] of pool.ticks) {
      const clmmTick = this.clmm["_getOrCreateTick"](tickIndex);
      clmmTick.liquidityNet = D(tickData.liquidityNet.toString());
      clmmTick.feeGrowthOutside0X128 =
        tickData.feeGrowthOutside0X64 * scaleFactor;
      clmmTick.feeGrowthOutside1X128 =
        tickData.feeGrowthOutside1X64 * scaleFactor;
    }
  }

  /**
   * Sync CLMM state back to Pool
   * Call this after CLMM calculations to update Pool
   */
  syncToPool(pool: {
    sqrtPriceX64: bigint;
    tickCurrent: number;
    liquidity: bigint;
    feeGrowthGlobal0X64: bigint;
    feeGrowthGlobal1X64: bigint;
  }): void {
    pool.sqrtPriceX64 = this.clmm.sqrtPriceX64;
    pool.tickCurrent = this.clmm.currentTick;
    pool.liquidity = BigInt(this.clmm.liquidity.toFixed(0));

    // Scale back from X128 to X64
    const scaleFactor = 2n ** 64n;
    pool.feeGrowthGlobal0X64 = this.clmm.feeGrowthGlobal0X128 / scaleFactor;
    pool.feeGrowthGlobal1X64 = this.clmm.feeGrowthGlobal1X128 / scaleFactor;
  }

  /**
   * Execute swap using CLMM's precise logic
   * Returns results in Pool's bigint format
   */
  executeSwap(
    amountIn: bigint,
    zeroForOne: boolean
  ): {
    amountOut: bigint;
    feePaid: bigint;
    newSqrtPriceX64: bigint;
    newTick: number;
    ticksCrossed: number;
  } {
    const swapArgs: SwapArgs = {
      zeroForOne,
      amountSpecified: D(amountIn.toString()),
      priceLimit: null,
    };

    const result = this.clmm.swap(swapArgs);

    return {
      amountOut: BigInt(result.amountOut.toFixed(0)),
      feePaid: BigInt(result.feePaid.toFixed(0)),
      newSqrtPriceX64: this.clmm.sqrtPriceX64,
      newTick: this.clmm.currentTick,
      ticksCrossed: result.ticksCrossed,
    };
  }

  /**
   * Calculate fee growth inside a tick range
   */
  calculateFeeGrowthInside(
    tickLower: number,
    tickUpper: number,
    tokenIndex: 0 | 1
  ): bigint {
    const { feeInside0X128, feeInside1X128 } = this.clmm[
      "_feeGrowthInsideX128"
    ](tickLower, tickUpper);

    // Scale from X128 to X64
    const scaleFactor = 2n ** 64n;
    return tokenIndex === 0
      ? feeInside0X128 / scaleFactor
      : feeInside1X128 / scaleFactor;
  }

  /**
   * Add liquidity using CLMM logic
   */
  addLiquidity(
    owner: string,
    tickLower: number,
    tickUpper: number,
    amount0: bigint,
    amount1: bigint
  ): { liquidity: bigint; id: string } {
    const result = this.clmm.mint({
      owner,
      lower: tickLower,
      upper: tickUpper,
      amount0: D(amount0.toString()),
      amount1: D(amount1.toString()),
    });

    return {
      liquidity: BigInt(result.liquidity.toFixed(0)),
      id: result.id,
    };
  }

  /**
   * Remove liquidity using CLMM logic
   */
  removeLiquidity(
    owner: string,
    tickLower: number,
    tickUpper: number,
    liquidity: bigint
  ): {
    amount0: bigint;
    amount1: bigint;
    fees0: bigint;
    fees1: bigint;
  } {
    const result = this.clmm.burn({
      owner,
      lower: tickLower,
      upper: tickUpper,
      liquidity: D(liquidity.toString()),
    });

    return {
      amount0: BigInt(result.amount0.toFixed(0)),
      amount1: BigInt(result.amount1.toFixed(0)),
      fees0: BigInt(result.fees0.toFixed(0)),
      fees1: BigInt(result.fees1.toFixed(0)),
    };
  }
}
