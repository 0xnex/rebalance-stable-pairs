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

    const priceBefore = LiquidityCalculator.sqrtPriceX64ToPrice(
      event.sqrtPriceBeforeX64
    );
    const priceAfter = LiquidityCalculator.sqrtPriceX64ToPrice(
      event.sqrtPriceAfterX64
    );

    // Calculate fee rate and slippage metrics
    const feeRate = event.amountIn > 0n ? 
      (Number(event.fee) / Number(event.amountIn)) * 100 : 0;
    const priceImpact = priceBefore > 0 ? 
      Math.abs((priceAfter - priceBefore) / priceBefore) * 100 : 0;
    
    // Calculate expected output without slippage for comparison
    const expectedOutput = event.zeroForOne ? 
      BigInt(Math.floor(Number(event.amountIn - event.fee) * priceBefore)) :
      BigInt(Math.floor(Number(event.amountIn - event.fee) / priceBefore));
    const actualSlippage = expectedOutput > event.amountOut ? 
      expectedOutput - event.amountOut : 0n;
    const slippageRate = expectedOutput > 0n ? 
      (Number(actualSlippage) / Number(expectedOutput)) * 100 : 0;

    console.log(
      `[Pool] Swap event: ` +
        `direction=${event.zeroForOne ? "0→1" : "1→0"}, ` +
        `tick: ${this.tickCurrent}→${event.tick}, ` +
        `price: ${priceBefore.toFixed(6)}→${priceAfter.toFixed(6)}, ` +
        `liquidity: ${this.liquidity.toString()}→${activeLiquidity.toString()}`
    );
    
    console.log(
      `[Pool-SwapDetails] ` +
        `amountIn=${event.amountIn.toString()}, ` +
        `amountOut=${event.amountOut.toString()}, ` +
        `fee=${event.fee.toString()} (${feeRate.toFixed(4)}%), ` +
        `priceImpact=${priceImpact.toFixed(4)}%, ` +
        `slippage=${actualSlippage.toString()} (${slippageRate.toFixed(4)}%)`
    );

    this.liquidity = activeLiquidity;
    this.tickCurrent = event.tick;
    this.sqrtPriceX64 = event.sqrtPriceAfterX64;
    this.reserve0 = event.reserve0;
    this.reserve1 = event.reserve1;
  }

  // @TODO compare to the swap event
  getValidationStats() {
    return {
      totalSwaps: 0,
      exactMatchRate: 0.0,
      amountOutMatchRate: 0.0,
      feeMatchRate: 0.0,
      protocolFeeMatchRate: 0.0,
    };
  }
}

export { Pool };
