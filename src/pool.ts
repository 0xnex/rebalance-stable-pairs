// pool.ts
import { LiquidityCalculator } from "./liquidity_calculator";
import type { SwapEvent } from "./backtest_engine";

const Q64 = 1n << 64n;
const Base = 1.0001;

class Pool {
  decimals0: number;
  decimals1: number;
  reserve0: bigint = 0n;
  reserve1: bigint = 0n;
  sqrtPriceBeforeX64: bigint = 0n;
  sqrtPriceX64: bigint = 0n; // Q64.64
  liquidity: bigint = 0n;
  tickCurrent: number = 0;
  tickSpacing: number;
  feeRatePpm: number; // fee rate expressed in millionths (from on-chain data)

  constructor(
    decimals0: number,
    decimals1: number,
    feeRatePpm: number = 100,
    tickSpacing: number = 2
  ) {
    this.decimals0 = decimals0;
    this.decimals1 = decimals1;
    this.tickSpacing = tickSpacing;
    this.feeRatePpm = feeRatePpm;
  }

  get price(): number {
    // Convert Q64.64 sqrtPrice to actual price
    // sqrtPriceX64 is sqrt(price) * 2^64
    const sqrtPrice = Number(this.sqrtPriceX64) / Number(Q64);
    return sqrtPrice * sqrtPrice;
  }

  update(event: SwapEvent) {
    // estimate active liquidity
    const activeLiquidity =
      LiquidityCalculator.calculateActiveLiquidityFromSwap(
        event.sqrtPriceBeforeX64,
        event.sqrtPriceAfterX64,
        event.amountIn,
        event.amountOut,
        event.zeroForOne
      );
    this.liquidity = activeLiquidity;
    this.tickCurrent = event.tick;
    this.sqrtPriceX64 = event.sqrtPriceAfterX64;
    this.reserve0 = event.reserve0;
    this.reserve1 = event.reserve1;
  }
}

export { Pool };
