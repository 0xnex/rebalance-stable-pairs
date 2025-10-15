import Decimal from "decimal.js";

/***************** Precision setup *****************/
export const D = (x: Decimal.Value) => new Decimal(x);
Decimal.set({
  precision: 80,
  rounding: Decimal.ROUND_HALF_UP,
  toExpNeg: -1e6,
  toExpPos: 1e6,
});

/***************** Fixed-point constants *****************/
const Q64 = D(2).pow(64); // Decimal helper
const Q64n = 1n << 64n; // bigint helper
const Q128n = 1n << 128n;
const LN_1_0001 = D(1.0001).ln();

/***************** Types *****************/
export type Address = string;

export interface PoolConfig {
  feeRatePpm: bigint; // 300 / 1000000 = 0.0003 for 0.03%
  tickSpacing: number; // e.g., 1 or 10 or 60
  initPrice: Decimal; // token1/token0 price
}

export interface SwapArgs {
  zeroForOne: boolean; // true: swap token0 -> token1
  amountSpecified: Decimal; // exact input (positive) or exact output (negative)
  priceLimit: Decimal | null; // optional limit price (token1/token0)
}

export interface MintByAmountsArgs {
  owner: Address;
  lower: number;
  upper: number;
  amount0: Decimal; // token0 budget
  amount1: Decimal; // token1 budget
}

export interface BurnArgs {
  owner: Address;
  lower: number;
  upper: number;
  liquidity: Decimal;
}

/***************** Tick/Position structures *****************/
class TickInfo {
  index: number;
  // Net liquidity change when crossing this tick upwards
  liquidityNet: Decimal = D(0);
  // Fee growth outside (Q128.128-esque via bigint numerator)
  feeGrowthOutside0X128: bigint = 0n;
  feeGrowthOutside1X128: bigint = 0n;
  constructor(index: number) {
    this.index = index;
  }
}

class PositionKey {
  owner: Address;
  lower: number;
  upper: number;
  constructor(owner: Address, lower: number, upper: number) {
    this.owner = owner;
    this.lower = lower;
    this.upper = upper;
  }
  id(): string {
    return `${this.owner}:${this.lower}:${this.upper}`;
  }
}

class Position {
  key: PositionKey;
  liquidity: Decimal = D(0);
  feeGrowthInside0LastX128: bigint = 0n;
  feeGrowthInside1LastX128: bigint = 0n;
  tokensOwed0: Decimal = D(0);
  tokensOwed1: Decimal = D(0);
  constructor(key: PositionKey) {
    this.key = key;
  }
}

/***************** Math helpers *****************/
export function tickToPrice(tick: number): Decimal {
  return D(1.0001).pow(tick);
}
export function priceToTick(price: Decimal.Value): number {
  return D(price)
    .ln()
    .div(LN_1_0001)
    .toNearest(1, Decimal.ROUND_HALF_EVEN)
    .toNumber();
}
export function tickToSqrtPriceX64(tick: number): bigint {
  const sqrt = D(1.0001)
    .pow(tick / 2)
    .mul(Q64);
  return BigInt(sqrt.toFixed(0));
}
export function priceToSqrtPriceX64(price: Decimal.Value): bigint {
  const sqrt = D(price).sqrt().mul(Q64);
  return BigInt(sqrt.toFixed(0));
}
export function sqrtPriceX64ToPrice(sqrtX64: bigint): Decimal {
  const s = D(sqrtX64.toString()).div(Q64);
  return s.mul(s);
}

// mulDiv for bigint: floor(a*b / d)
function mulDivFloor(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b) / d;
}
function mulDivCeil(a: bigint, b: bigint, d: bigint): bigint {
  return (a * b + d - 1n) / d;
}

/***************** Amount/Liquidity formulas (Decimal raw sqrt domain) *****************/
// Convert Q64.64 to raw Decimal sqrt
function rawSqrt(x64: bigint): Decimal {
  return D(x64.toString()).div(Q64);
}

function amountsForLiquidity(
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  L: Decimal
): { amount0: Decimal; amount1: Decimal } {
  const sa = Decimal.min(D(sqrtA.toString()), D(sqrtB.toString()));
  const sb = Decimal.max(D(sqrtA.toString()), D(sqrtB.toString()));
  const sp = D(sqrtP.toString());
  const saR = sa.div(Q64),
    sbR = sb.div(Q64),
    spR = sp.div(Q64);

  if (sp.lte(sa)) {
    // all in token0
    const amount0 = L.mul(sbR.sub(saR)).div(saR.mul(sbR));
    return { amount0, amount1: D(0) };
  } else if (sp.gte(sb)) {
    // all in token1
    const amount1 = L.mul(sbR.sub(saR));
    return { amount0: D(0), amount1 };
  } else {
    // both
    const amount0 = L.mul(sbR.sub(spR)).div(spR.mul(sbR));
    const amount1 = L.mul(spR.sub(saR));
    return { amount0, amount1 };
  }
}

function liquidityForAmounts(
  sqrtP: bigint,
  sqrtA: bigint,
  sqrtB: bigint,
  amount0Max: Decimal,
  amount1Max: Decimal
): Decimal {
  const sa = Decimal.min(D(sqrtA.toString()), D(sqrtB.toString()));
  const sb = Decimal.max(D(sqrtA.toString()), D(sqrtB.toString()));
  const sp = D(sqrtP.toString());
  const saR = sa.div(Q64),
    sbR = sb.div(Q64),
    spR = sp.div(Q64);
  if (sp.lte(sa)) {
    return amount0Max.mul(saR.mul(sbR)).div(sbR.sub(saR));
  } else if (sp.gte(sb)) {
    return amount1Max.div(sbR.sub(saR));
  } else {
    const L0 = amount0Max.mul(spR.mul(sbR)).div(sbR.sub(spR));
    const L1 = amount1Max.div(spR.sub(saR));
    return Decimal.min(L0, L1);
  }
}

/***************** Pool core *****************/
export class CLMM {
  // State
  feeRatePpm: bigint;
  tickSpacing: number;
  sqrtPriceX64: bigint;
  currentTick: number;
  liquidity: Decimal; // active liquidity in current tick
  feeGrowthGlobal0X128: bigint = 0n; // Q128.128-like accumulators via bigint ratio (numerator)
  feeGrowthGlobal1X128: bigint = 0n;

  // Storage tables
  ticks: Map<number, TickInfo> = new Map();
  positions: Map<string, Position> = new Map();

  static make(cfg: PoolConfig): CLMM {
    const c = new CLMM();
    c.feeBps = cfg.feeBps;
    c.tickSpacing = cfg.tickSpacing;
    c.sqrtPriceX64 = priceToSqrtPriceX64(cfg.initPrice);
    c.currentTick = priceToTick(cfg.initPrice);
    c.liquidity = D(0);
    return c;
  }

  // ----- Mint -----
  mint(args: MintByAmountsArgs): string {
    this._validateRange(args.lower, args.upper);
    const sa = tickToSqrtPriceX64(args.lower);
    const sb = tickToSqrtPriceX64(args.upper);
    const L = liquidityForAmounts(
      this.sqrtPriceX64,
      sa,
      sb,
      args.amount0,
      args.amount1
    );

    // compute actual debits (amount0/1) for accounting/reporting
    const { amount0, amount1 } = amountsForLiquidity(
      this.sqrtPriceX64,
      sa,
      sb,
      L
    );

    // update tick liquidityNet
    const tL = this._getOrCreateTick(args.lower);
    const tU = this._getOrCreateTick(args.upper);
    tL.liquidityNet = tL.liquidityNet.add(L);
    tU.liquidityNet = tU.liquidityNet.sub(L);

    // if inside active range, add to pool active liquidity
    if (this.currentTick >= args.lower && this.currentTick < args.upper) {
      this.liquidity = this.liquidity.add(L);
    }

    // position
    const key = new PositionKey(args.owner, args.lower, args.upper);
    const pos = this._getOrCreatePosition(key);
    // initialize fee growth inside baselines
    const { feeInside0X128, feeInside1X128 } = this._feeGrowthInsideX128(
      args.lower,
      args.upper
    );
    if (pos.liquidity.eq(0)) {
      pos.feeGrowthInside0LastX128 = feeInside0X128;
      pos.feeGrowthInside1LastX128 = feeInside1X128;
    }
    pos.liquidity = pos.liquidity.add(L);

    return key.id();
  }

  // ----- Burn -----
  burn(a: BurnArgs): {
    amount0: Decimal;
    amount1: Decimal;
    fees0: Decimal;
    fees1: Decimal;
  } {
    const key = new PositionKey(a.owner, a.lower, a.upper);
    const pos = this.positions.get(key.id());
    if (!pos) throw new Error("position not found");
    if (a.liquidity.gt(pos.liquidity))
      throw new Error("insufficient position liquidity");

    // settle fees to tokensOwed*
    this._updatePositionFees(pos);

    // compute amounts returned (no fee) for removing L
    const sa = tickToSqrtPriceX64(a.lower);
    const sb = tickToSqrtPriceX64(a.upper);
    const { amount0, amount1 } = amountsForLiquidity(
      this.sqrtPriceX64,
      sa,
      sb,
      a.liquidity
    );

    // Update storage: ticks and active liquidity
    const tL = this._getOrCreateTick(a.lower);
    const tU = this._getOrCreateTick(a.upper);
    tL.liquidityNet = tL.liquidityNet.sub(a.liquidity);
    tU.liquidityNet = tU.liquidityNet.add(a.liquidity);

    if (this.currentTick >= a.lower && this.currentTick < a.upper) {
      this.liquidity = this.liquidity.sub(a.liquidity);
    }

    pos.liquidity = pos.liquidity.sub(a.liquidity);

    // return principal + any accrued fees (do not zero tokensOwed here; leave for collect)
    return { amount0, amount1, fees0: pos.tokensOwed0, fees1: pos.tokensOwed1 };
  }

  // ----- Collect accrued fees -----
  collect(
    owner: Address,
    lower: number,
    upper: number
  ): { fees0: Decimal; fees1: Decimal } {
    const key = new PositionKey(owner, lower, upper);
    const pos = this.positions.get(key.id());
    if (!pos) throw new Error("position not found");
    this._updatePositionFees(pos);
    const f0 = pos.tokensOwed0;
    const f1 = pos.tokensOwed1;
    pos.tokensOwed0 = D(0);
    pos.tokensOwed1 = D(0);
    return { fees0: f0, fees1: f1 };
  }

  // ----- Swap core (exact in; no flash/observations) -----
  swap(a: SwapArgs): {
    amountIn: Decimal;
    amountOut: Decimal;
    feePaid: Decimal;
    ticksCrossed: number;
  } {
    if (this.liquidity.lte(0)) throw new Error("no active liquidity");

    const priceLimitX64 = a.priceLimit
      ? priceToSqrtPriceX64(a.priceLimit)
      : a.zeroForOne
      ? tickToSqrtPriceX64(-887272)
      : tickToSqrtPriceX64(887272);

    let amountSpecifiedRemaining = a.amountSpecified.abs();
    let amountIn = D(0);
    let amountOut = D(0);
    let feePaid = D(0);
    let ticksCrossed = 0;

    while (amountSpecifiedRemaining.gt(0)) {
      const nextTick = a.zeroForOne
        ? this._nextInitializedTickLeft(this.currentTick)
        : this._nextInitializedTickRight(this.currentTick);
      const targetTick = a.zeroForOne
        ? Math.max(nextTick, priceToTick(sqrtPriceX64ToPrice(priceLimitX64)))
        : Math.min(nextTick, priceToTick(sqrtPriceX64ToPrice(priceLimitX64)));

      const sqrtTargetX64 = a.zeroForOne
        ? priceLimitX64 < this.sqrtPriceX64
          ? priceLimitX64
          : tickToSqrtPriceX64(targetTick)
        : priceLimitX64 > this.sqrtPriceX64
        ? priceLimitX64
        : tickToSqrtPriceX64(targetTick);

      // Compute swap within [current sqrt, target sqrt]
      const step = this._computeSwapStep(
        this.sqrtPriceX64,
        sqrtTargetX64,
        this.liquidity,
        this.feeBps,
        a.zeroForOne,
        amountSpecifiedRemaining
      );
      // Update globals
      this.sqrtPriceX64 = step.nextSqrtPriceX64;
      amountIn = amountIn.add(step.amountIn);
      amountOut = amountOut.add(step.amountOut);
      feePaid = feePaid.add(step.feeAmount);
      amountSpecifiedRemaining = amountSpecifiedRemaining.sub(step.consumed);

      if (
        this.sqrtPriceX64 === sqrtTargetX64 &&
        this.currentTick !== targetTick
      ) {
        // crossing tick
        ticksCrossed++;
        this._crossTick(targetTick);
      } else {
        // reached price limit or fully consumed
        break;
      }
    }

    return { amountIn, amountOut, feePaid, ticksCrossed };
  }

  /***************** Private internals *****************/
  private _validateRange(l: number, u: number) {
    if (!(l < u)) throw new Error("invalid range");
    if (l % this.tickSpacing !== 0 || u % this.tickSpacing !== 0)
      throw new Error("range not aligned to tickSpacing");
  }

  private _getOrCreateTick(i: number): TickInfo {
    let t = this.ticks.get(i);
    if (!t) {
      t = new TickInfo(i);
      this.ticks.set(i, t);
    }
    return t;
  }

  private _getOrCreatePosition(k: PositionKey): Position {
    const id = k.id();
    let p = this.positions.get(id);
    if (!p) {
      p = new Position(k);
      this.positions.set(id, p);
    }
    return p;
  }

  private _feeGrowthInsideX128(
    lower: number,
    upper: number
  ): { feeInside0X128: bigint; feeInside1X128: bigint } {
    const lowerTick = this._getOrCreateTick(lower);
    const upperTick = this._getOrCreateTick(upper);

    // feeInside = feeGlobal - feeOutside(lower) - feeOutside(upper)
    let feeInside0 =
      this.feeGrowthGlobal0X128 -
      lowerTick.feeGrowthOutside0X128 -
      upperTick.feeGrowthOutside0X128;
    let feeInside1 =
      this.feeGrowthGlobal1X128 -
      lowerTick.feeGrowthOutside1X128 -
      upperTick.feeGrowthOutside1X128;
    return { feeInside0X128: feeInside0, feeInside1X128: feeInside1 };
  }

  private _updatePositionFees(pos: Position) {
    const { feeInside0X128, feeInside1X128 } = this._feeGrowthInsideX128(
      pos.key.lower,
      pos.key.upper
    );
    const delta0 = feeInside0X128 - pos.feeGrowthInside0LastX128;
    const delta1 = feeInside1X128 - pos.feeGrowthInside1LastX128;

    // Convert bigint Q128.128 to Decimal by dividing by 2^128 and multiplying by liquidity
    const owed0 = D(delta0.toString())
      .div(D(Q128n.toString()))
      .mul(pos.liquidity);
    const owed1 = D(delta1.toString())
      .div(D(Q128n.toString()))
      .mul(pos.liquidity);

    pos.tokensOwed0 = pos.tokensOwed0.add(owed0);
    pos.tokensOwed1 = pos.tokensOwed1.add(owed1);

    pos.feeGrowthInside0LastX128 = feeInside0X128;
    pos.feeGrowthInside1LastX128 = feeInside1X128;
  }

  private _crossTick(targetTick: number) {
    const t = this._getOrCreateTick(targetTick);

    // Update fee growth outside to snapshot current globals at crossing time
    t.feeGrowthOutside0X128 =
      this.feeGrowthGlobal0X128 - t.feeGrowthOutside0X128;
    t.feeGrowthOutside1X128 =
      this.feeGrowthGlobal1X128 - t.feeGrowthOutside1X128;

    // Update active liquidity according to crossing direction
    // If crossing upwards (price increases): add liquidityNet
    // If crossing downwards: subtract liquidityNet
    const upwards = targetTick >= this.currentTick;
    if (upwards) {
      this.liquidity = this.liquidity.add(t.liquidityNet);
    } else {
      this.liquidity = this.liquidity.sub(t.liquidityNet);
    }

    this.currentTick = targetTick;
  }

  private _nextInitializedTickRight(fromTick: number): number {
    // naive scan; optimize with bitmaps in production
    let t = fromTick + this.tickSpacing;
    let best = fromTick + this.tickSpacing;
    for (let i = 0; i < 500000; i++) {
      // safety bound for tests
      if (this.ticks.has(t)) {
        best = t;
        break;
      }
      t += this.tickSpacing;
    }
    return best;
  }

  private _nextInitializedTickLeft(fromTick: number): number {
    let t = fromTick - this.tickSpacing;
    let best = fromTick - this.tickSpacing;
    for (let i = 0; i < 500000; i++) {
      if (this.ticks.has(t)) {
        best = t;
        break;
      }
      t -= this.tickSpacing;
    }
    return best;
  }

  private _computeSwapStep(
    sqrtPStartX64: bigint,
    sqrtPTargetX64: bigint,
    liquidity: Decimal,
    feeBps: number,
    zeroForOne: boolean,
    amountRemaining: Decimal
  ): {
    nextSqrtPriceX64: bigint;
    amountIn: Decimal;
    amountOut: Decimal;
    feeAmount: Decimal;
    consumed: Decimal;
  } {
    if (liquidity.lte(0)) throw new Error("zero liquidity");

    const L = liquidity; // Decimal
    const s0 = D(sqrtPStartX64.toString()).div(Q64);
    const sT = D(sqrtPTargetX64.toString()).div(Q64);

    // fee fraction
    const fee = D(feeBps).div(10000);

    // How much input to move from s0 to sT inside this tick-range?
    // Formulas:
    //   For zeroForOne (x->y), price decreases: dx = L * (sT - s0) / (sT * s0)
    //   dy = L * (s0 - sT)
    //   For oneForZero (y->x), price increases: dy = L * (sT - s0)
    //   dx = L * (s0 - sT) / (sT * s0)

    let amountInNoFee: Decimal;
    let amountOutAbs: Decimal;

    if (zeroForOne) {
      if (sT.gte(s0))
        throw new Error("invalid target (must be < current for zeroForOne)");
      amountInNoFee = L.mul(s0.sub(sT)).div(sT.mul(s0));
      amountOutAbs = L.mul(s0.sub(sT));
    } else {
      if (sT.lte(s0))
        throw new Error("invalid target (must be > current for oneForZero)");
      amountInNoFee = L.mul(sT.sub(s0));
      amountOutAbs = L.mul(sT.sub(s0)).div(sT.mul(s0));
    }

    // include fee on input side
    const amountInWithFee = amountInNoFee.div(D(1).sub(fee));

    if (amountRemaining.lt(amountInWithFee)) {
      // we cannot reach target; solve for next sqrt given partial input
      const effectiveIn = amountRemaining.mul(D(1).sub(fee)); // after fee
      let nextSqrt: Decimal;
      if (zeroForOne) {
        // effectiveIn = L * (s0 - s1) / (s1*s0) => solve for s1
        // Rearranged: effectiveIn * s1 * s0 = L * (s0 - s1)
        // => effectiveIn * s1 * s0 + L * s1 = L * s0
        // => s1 * (effectiveIn * s0 + L) = L * s0
        nextSqrt = L.mul(s0).div(effectiveIn.mul(s0).add(L));
      } else {
        // effectiveIn = L * (s1 - s0) => s1 = s0 + effectiveIn / L
        nextSqrt = s0.add(effectiveIn.div(L));
      }

      const nextSqrtX64 = BigInt(nextSqrt.mul(Q64).toFixed(0));
      // recompute realized amounts between s0 and nextSqrt
      if (zeroForOne) {
        const dx = L.mul(s0.sub(nextSqrt)).div(nextSqrt.mul(s0));
        const dy = L.mul(s0.sub(nextSqrt));
        const feeAmt = dx.mul(fee).div(D(1).sub(fee)); // input side fee gross-up
        return {
          nextSqrtPriceX64: nextSqrtX64,
          amountIn: dx.add(feeAmt),
          amountOut: dy, // token1 out
          feeAmount: feeAmt,
          consumed: dx.add(feeAmt),
        };
      } else {
        const dyIn = L.mul(nextSqrt.sub(s0));
        const dxOut = L.mul(nextSqrt.sub(s0)).div(nextSqrt.mul(s0));
        const feeAmt = dyIn.mul(fee).div(D(1).sub(fee));
        return {
          nextSqrtPriceX64: nextSqrtX64,
          amountIn: dyIn.add(feeAmt),
          amountOut: dxOut, // token0 out
          feeAmount: feeAmt,
          consumed: dyIn.add(feeAmt),
        };
      }
    } else {
      // reach target within this step
      const feeAmt = amountInWithFee.sub(amountInNoFee); // fee on input
      return {
        nextSqrtPriceX64: sqrtPTargetX64,
        amountIn: amountInWithFee,
        amountOut: amountOutAbs,
        feeAmount: feeAmt,
        consumed: amountInWithFee,
      };
    }
  }

  /***************** Inspection helpers *****************/
  stateToJSON() {
    const ticks = Array.from(this.ticks.values())
      .sort((a, b) => a.index - b.index)
      .map((t) => ({
        index: t.index,
        liquidityNet: t.liquidityNet.toString(),
        feeOut0X128: t.feeGrowthOutside0X128.toString(),
        feeOut1X128: t.feeGrowthOutside1X128.toString(),
      }));
    const positions = Array.from(this.positions.values()).map((p) => ({
      id: p.key.id(),
      liquidity: p.liquidity.toString(),
      owed0: p.tokensOwed0.toString(),
      owed1: p.tokensOwed1.toString(),
    }));
    return {
      feeBps: this.feeBps,
      tickSpacing: this.tickSpacing,
      price: sqrtPriceX64ToPrice(this.sqrtPriceX64).toString(),
      sqrtPriceX64: this.sqrtPriceX64.toString(),
      currentTick: this.currentTick,
      liquidity: this.liquidity.toString(),
      feeGrowthGlobal0X128: this.feeGrowthGlobal0X128.toString(),
      feeGrowthGlobal1X128: this.feeGrowthGlobal1X128.toString(),
      ticks,
      positions,
    };
  }
}

export default CLMM;
