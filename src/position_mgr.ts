import { type IPositionManager, type IPosition, type IPool, type SwapEvent, type IWallet } from "./types";
import { FeeDistributor } from "./fee_distributor";

/**
 * Wallet implementation to track fund's available balance
 */
class Wallet implements IWallet {
  public amount0: bigint;
  public amount1: bigint;

  constructor(amount0: bigint, amount1: bigint) {
    this.amount0 = amount0;
    this.amount1 = amount1;
  }

  updateBalance(deltaAmount0: bigint, deltaAmount1: bigint): void {
    this.amount0 += deltaAmount0;
    this.amount1 += deltaAmount1;
    
    if (this.amount0 < 0n || this.amount1 < 0n) {
      throw new Error(`[WALLET] [insufficient_balance] [amount0=${this.amount0}] [amount1=${this.amount1}]`);
    }
  }
}

class Position implements IPosition {
  public readonly id: string;
  public readonly lower: number;
  public readonly upper: number;
  public initialAmount0: bigint = 0n;
  public initialAmount1: bigint = 0n; 
  public fee0: bigint = 0n;
  public fee1: bigint = 0n;
  public accumulatedFee0: bigint = 0n;
  public accumulatedFee1: bigint = 0n;
  public cost0: bigint = 0n;
  public cost1: bigint = 0n;
  public slip0: bigint = 0n;
  public slip1: bigint = 0n;
  public L: bigint = 0n;
  public isClosed: boolean = false;

  private pool: IPool;

  constructor(id: string, lower: number, upper: number, pool: IPool) {
    this.id = id;
    this.lower = lower;
    this.upper = upper;
    this.pool = pool;
  }

  // Calculated property - derives amounts from liquidity
  get amount0(): bigint {
    if (this.L === 0n) return 0n;
    const amounts = this.pool.removeLiquidity(this.L, this.lower, this.upper);
    return amounts.amount0;
  }

  get amount1(): bigint {
    if (this.L === 0n) return 0n;
    const amounts = this.pool.removeLiquidity(this.L, this.lower, this.upper);
    return amounts.amount1;
  }

  getValue(price: number): bigint {
    return (
      (this.amount0 + this.fee0) * BigInt(price) + (this.amount1 + this.fee1)
    );
  }

  isInRange(currentTick: number): boolean {
    return currentTick >= this.lower && currentTick <= this.upper;
  }

  updateFee(fee0: bigint, fee1: bigint): void {
    this.fee0 += fee0;
    this.fee1 += fee1;
    this.accumulatedFee0 += fee0;
    this.accumulatedFee1 += fee1;
  }

  close(): { amount0: bigint; amount1: bigint; fee0: bigint; fee1: bigint } {
    this.isClosed = true;
    const finalAmount0 = this.amount0;
    const finalAmount1 = this.amount1;
    this.L = 0n; // Clear liquidity
    const collectedFee0 = this.fee0;
    const collectedFee1 = this.fee1;
    this.fee0 = 0n;
    this.fee1 = 0n;
    return { amount0: finalAmount0, amount1: finalAmount1, fee0: collectedFee0, fee1: collectedFee1 };
  }
}

class PositionManager implements IPositionManager {
  private initialAmount0: bigint = 0n;
  private initialAmount1: bigint = 0n;
  private wallet: Wallet; // Global fund wallet
  private accumulatedFee0: bigint = 0n;
  private accumulatedFee1: bigint = 0n;
  private positions: Map<string, IPosition> = new Map();
  private pool: IPool;
  private feeDistributor: FeeDistributor;

  constructor(amount0: bigint, amount1: bigint, pool: IPool) {
    this.initialAmount0 = amount0;
    this.initialAmount1 = amount1;
    this.wallet = new Wallet(amount0, amount1); // Initialize wallet with initial balance
    this.pool = pool;
    this.feeDistributor = new FeeDistributor(this.positions);
  }

  openPosition(id: string, lower: number, upper: number): void {
    let pos = this.positions.get(id);
    
    if (pos && !pos.isClosed) {
      throw new Error(`Position ${id} already exists and is not closed`);
    }

    if (!pos) {
      pos = new Position(id, lower, upper, this.pool);
    }

    console.log("[OPEN POSITION]", id, lower, upper);
    this.positions.set(id, pos);
    
    // Initialize fee tracking for this position
    this.feeDistributor.initializePosition(id);
  }

  addLiquidity(id: string, amount0: bigint, amount1: bigint): { liquidity: bigint; amount0Used: bigint; amount1Used: bigint } {
    if (!this.positions.has(id)) {
      throw new Error(`Position ${id} does not exist`);
    }
    const position = this.positions.get(id) as IPosition;

    if (position.isClosed) {
      throw new Error(`Position ${id} is closed`);
    }

    // Check wallet has sufficient balance
    if (this.wallet.amount0 < amount0 || this.wallet.amount1 < amount1) {
      throw new Error(
        `[POSITION_MGR] [insufficient_wallet_balance] ` +
        `[requested_amount0=${amount0}] [available=${this.wallet.amount0}] ` +
        `[requested_amount1=${amount1}] [available=${this.wallet.amount1}]`
      );
    }

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
    
    position.initialAmount0 += amount0;
    position.initialAmount1 += amount1;
    // Only update liquidity - amounts are calculated on demand
    position.L += optimizationResult.maxLResult.L;
    
    // Deduct used amounts from wallet (including swap fees and slippage)
    const totalCost0 = optimizationResult.maxLResult.amount0Used + 
                       optimizationResult.maxLResult.fee0 + 
                       optimizationResult.maxLResult.slip0;
    const totalCost1 = optimizationResult.maxLResult.amount1Used + 
                       optimizationResult.maxLResult.fee1 + 
                       optimizationResult.maxLResult.slip1;
    
    this.wallet.updateBalance(-totalCost0, -totalCost1);
    
    return {
      liquidity: optimizationResult.maxLResult.L,
      amount0Used: optimizationResult.maxLResult.amount0Used,
      amount1Used: optimizationResult.maxLResult.amount1Used,
    };
  }

  removeLiquidity(id: string, liquidity: bigint): { amount0: bigint; amount1: bigint } {
    if (!this.isActive(id)) {
      throw new Error(`Position ${id} is not active`);
    }
    const position = this.positions.get(id) as IPosition;
    
    if (position.L < liquidity) {
      throw new Error(`Position ${id} has not enough liquidity`);
    }

    // Calculate amounts for the liquidity being removed
    const amounts = this.pool.removeLiquidity(liquidity, position.lower, position.upper);
    
    // Update position liquidity
    position.L -= liquidity;
    
    // Return removed amounts to wallet
    this.wallet.updateBalance(amounts.amount0, amounts.amount1);
    
    return amounts;
  }

  closePosition(id: string): {
    amount0: bigint;
    amount1: bigint;
    fee0: bigint;
    fee1: bigint;
  } {
    if (!this.positions.has(id)) {
      throw new Error(`Position ${id} does not exist`);
    }
    const position = this.positions.get(id) as IPosition;
    const result = position.close();
    
    // Return all amounts and fees to wallet
    this.wallet.updateBalance(
      result.amount0 + result.fee0,
      result.amount1 + result.fee1
    );
    
    return result;
  }

  fee(id: string): { fee0: bigint; fee1: bigint } {
    if (!this.positions.has(id)) {
      throw new Error(`Position ${id} does not exist`);
    }
    const position = this.positions.get(id) as IPosition;
    return { fee0: position.fee0, fee1: position.fee1 };
  }

  claimFee(id: string): { fee0: bigint; fee1: bigint } {
    if (!this.positions.has(id)) {
      throw new Error(`Position ${id} does not exist`);
    }
    const position = this.positions.get(id) as IPosition;
    const fees = { fee0: position.fee0, fee1: position.fee1 };
    position.fee0 = 0n;
    position.fee1 = 0n;
    
    // Add claimed fees to wallet
    this.wallet.updateBalance(fees.fee0, fees.fee1);
    
    return fees;
  }

  getPosition(id: string): IPosition {
    const position = this.positions.get(id);
    if (!position) {
      throw new Error(`Position ${id} does not exist`);
    }
    return position;
  }

  getPositions(): IPosition[] {
    return Array.from(this.positions.values());
  }

  getActivePositions(): IPosition[] {
    return Array.from(this.positions.values()).filter(pos => !pos.isClosed);
  }

  updateFee(id: string, fee0: bigint, fee1: bigint): void {
    if (!this.positions.has(id)) {
      throw new Error(`Position ${id} does not exist`);
    }
    const position = this.positions.get(id) as IPosition;
    position.updateFee(fee0, fee1);
    this.accumulatedFee0 += fee0;
    this.accumulatedFee1 += fee1;
  }

  isActive(id: string): boolean {
    return this.positions.has(id) && !this.positions.get(id)?.isClosed;
  }

  /**
   * Handle swap event - distribute fees to all in-range positions
   */
  onSwapEvent(swapEvent: SwapEvent): void {
    this.feeDistributor.onSwapEvent(swapEvent);
  }

  /**
   * Get fee distributor for external access
   */
  getFeeDistributor(): FeeDistributor {
    return this.feeDistributor;
  }

  /**
   * Get the fund's wallet
   */
  getWallet(): IWallet {
    return this.wallet;
  }

  /**
   * Get available balance of token0 in wallet
   */
  getBalance0(): bigint {
    return this.wallet.amount0;
  }

  /**
   * Get available balance of token1 in wallet
   */
  getBalance1(): bigint {
    return this.wallet.amount1;
  }

  /**
   * Get all positions (including closed ones)
   */
  getAllPositions(): IPosition[] {
    return this.getPositions();
  }
}

export { PositionManager, Position, Wallet };
