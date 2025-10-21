import { describe, it, expect, beforeEach } from "bun:test";
import { Pool } from "../src/pool";

const M = 1000000n;
describe("Pool full coverage", () => {
  let pool: Pool;
  beforeEach(() => {
    pool = new Pool(100n, 60);
    pool.sqrtPriceX64 = pool.tickToSqrtPrice(7);
    pool.liquidity = 1000000n;
    pool.tickCurrent = 7;
  });

  it("price getter", () => {
    expect(pool.price).toBeCloseTo(Math.pow(1.0001, 7), 8);
  });

  it("tickToSqrtPrice and sqrtPriceToTick", () => {
    const tick = 7;
    const sqrtPrice = pool.tickToSqrtPrice(tick);
    expect(pool.sqrtPriceToTick(sqrtPrice)).toBe(tick);
  });

  it("applyLiquidityDelta", () => {
    pool.applyLiquidityDelta(5, 10, 1000n);
    expect(pool.liquidity > 0n).toBe(true);
  });

  it("calculateFees", () => {
    const fees = pool["calculateFees"](10000n);
    expect(fees.totalFee > 0n).toBe(true);
    expect(fees.lpFee > 0n).toBe(true);
    expect(fees.protocolFee >= 0n).toBe(true);
  });

  it("serialize/deserialize", () => {
    const s = pool.serialize();
    const pool2 = Pool.deserialize(s);
    expect(pool2.liquidity).toBe(pool.liquidity);
    expect(pool2.tickCurrent).toBe(pool.tickCurrent);
  });

  it("mulDivRoundingDown", () => {
    expect(pool["mulDivRoundingDown"](10n, 5n, 2n)).toBe(25n);
  });

  it("estimateAmountOut", () => {
    const result = pool.estimateAmountOut(10000n, true);
    expect(result.amountOut >= 0n).toBe(true);
    expect(result.feeAmount >= 0n).toBe(true);
    expect(typeof result.priceImpact).toBe("number");
  });

  it("estimateAmountIn", () => {
    const result = pool.estimateAmountIn(5000n, true);
    expect(result.amountIn >= 0n).toBe(true);
    expect(result.feeAmount >= 0n).toBe(true);
    expect(result.totalCost >= 0n).toBe(true);
    expect(typeof result.priceImpact).toBe("number");
  });

  it("estimateSwapCost", () => {
    const result = pool.estimateSwapCost(10000n, true);
    expect(result.amountOut >= 0n).toBe(true);
    expect(result.feeAmount >= 0n).toBe(true);
    expect(typeof result.priceImpact).toBe("number");
    expect(typeof result.effectivePrice).toBe("number");
    expect(typeof result.slippage).toBe("number");
    expect(result.totalCost >= 0n).toBe(true);
  });
});
