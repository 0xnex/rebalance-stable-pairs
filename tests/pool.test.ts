import { describe, it, expect, beforeEach } from "bun:test";
import { Pool } from "../src/pool";

const M = 1000000;
describe("Pool", () => {
  const pool = new Pool(10 / M, 2);
  it("price", () => {
    pool.sqrtPriceX64 = 18453686264384000442n;
    expect(pool.price).toBeCloseTo(1.0007528154505747, 8);
    expect(pool.sqrtPriceToTick(pool.sqrtPriceX64)).toBe(7);
  });

  it("add liquidity", () => {
    const pool = new Pool(10 / M, 2);
    pool.sqrtPriceX64 = 18452461678281015883n;
    pool.feeRatePpm = 10n;
  });
});
