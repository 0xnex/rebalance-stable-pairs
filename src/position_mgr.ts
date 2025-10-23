import { type IPositionManager, type IPosition, type IPool } from "./types";

class Position implements IPosition {
  private id: string;
  public readonly lower: number;
  public readonly upper: number;
  public initialAmount0: bigint = 0n;
  public initialAmount1: bigint = 0n;
  private fee0: bigint = 0n;
  private fee1: bigint = 0n;
  private accumulatedFee0: bigint = 0n;
  private accumulatedFee1: bigint = 0n;
  private amount0: bigint = 0n;
  private amount1: bigint = 0n;
  public cost0: bigint = 0n;
  public cost1: bigint = 0n;
  public slip0: bigint = 0n;
  public slip1: bigint = 0n;
  private L: bigint = 0n;

  constructor(id: string, lower: number, upper: number) {
    this.id = id;
    this.lower = lower;
    this.upper = upper;
  }
  getValue(price: number): bigint {
    return (
      (this.amount0 + this.fee0) * BigInt(price) + (this.amount1 + this.fee1)
    );
  }

  isInRange(currentTick: number): boolean {
    return currentTick >= this.lower && currentTick <= this.upper;
  }
}

class PositionManager implements IPositionManager {
  private initialAmount0: bigint = 0n;
  private initialAmount1: bigint = 0n;
  private balance0: bigint = 0n; // balance of token0
  private balance1: bigint = 0n; // balance of token1
  private accumulatedFee0: bigint = 0n;
  private accumulatedFee1: bigint = 0n;
  private positions: Map<string, IPosition> = new Map();
  private pool: IPool;

  constructor(amount0: bigint, amount1: bigint, pool: IPool) {
    this.initialAmount0 = amount0;
    this.initialAmount1 = amount1;
    this.balance0 = amount0;
    this.balance1 = amount1;
    this.pool = pool;
  }

  openPosition(id: string, lower: number, upper: number): void {
    if (this.positions.has(id)) {
      throw new Error(`Position ${id} already exists`);
    }
    const position = new Position(id, lower, upper);
    this.positions.set(id, position);
  }

  addLiquidity(id: string, amount0: bigint, amount1: bigint): void {
    if (!this.positions.has(id)) {
      throw new Error(`Position ${id} does not exist`);
    }
    const position = this.positions.get(id) as Position;

    const optimizationResult = this.pool.optimizeForMaxL(
      amount0,
      amount1,
      position.lower,
      position.upper
    );

    if (optimizationResult.needSwap) {
      // record swap stat
      console.log(
        "[SWAP]",
        id,
        optimizationResult.swapDirection,
        optimizationResult.swapAmount,
        optimizationResult.swapResult?.amountOut,
        optimizationResult.swapResult?.fee,
        optimizationResult.swapResult?.slippage
      );

      if (optimizationResult.swapDirection === "0to1") {
        position.cost0 += optimizationResult.swapResult?.fee ?? 0n;
        position.slip1 += optimizationResult.swapResult?.slippage ?? 0n;
      } else {
        position.cost1 += optimizationResult.swapResult?.fee ?? 0n;
        position.slip0 += optimizationResult.swapResult?.slippage ?? 0n;
      }
    }
    optimizationResult.maxLResult.amount0Used;
    optimizationResult.maxLResult.amount1Used;
    optimizationResult.maxLResult.fee0;
    optimizationResult.maxLResult.fee1;
    optimizationResult.maxLResult.slip0;
    optimizationResult.maxLResult.slip1;
    return {
      liquidity: optimizationResult.maxLResult.L,
      amount0Used: optimizationResult.maxLResult.amount0Used,
      amount1Used: optimizationResult.maxLResult.amount1Used,
    };
  }
}
