/**
 * 适配器：让简化的 FeeCollectionManager 与现有系统协同工作
 */

import type { VirtualPositionManager } from "../virtual_position_mgr";
import type { Pool } from "../pool";
import type { PositionManager, PriceProvider } from "./types";

/**
 * VirtualPositionManager 适配器
 * 将 VirtualPositionManager 适配为 FeeCollectionManager 需要的 PositionManager 接口
 */
export class VirtualPositionManagerAdapter implements PositionManager {
  constructor(private virtualManager: VirtualPositionManager) {}

  getPosition(positionId: string): any {
    const positions = this.virtualManager.getAllPositions();
    return positions.find((p) => p.id === positionId) || null;
  }

  collectFees(positionId: string): { fee0: bigint; fee1: bigint } | null {
    return this.virtualManager.collectFees(positionId);
  }

  addToPosition(positionId: string, amount0: bigint, amount1: bigint): boolean {
    // Now we can use the new addLiquidity method
    try {
      const result = this.virtualManager.addLiquidity(
        positionId,
        amount0,
        amount1
      );

      if (result.success) {
        console.log(
          `[VirtualPositionManagerAdapter] Successfully added liquidity to position ${positionId}: ` +
            `+${result.addedLiquidity} L (total: ${result.totalLiquidity}), ` +
            `used ${result.usedAmount0} token0 + ${result.usedAmount1} token1`
        );
        return true;
      } else {
        console.warn(
          `[VirtualPositionManagerAdapter] Failed to add liquidity to position ${positionId}: ${result.message}`
        );
        return false;
      }
    } catch (err) {
      console.warn(
        `[VirtualPositionManagerAdapter] Error adding liquidity to position ${positionId}:`,
        err
      );
      return false;
    }
  }

  getTotals(): {
    amountA: bigint;
    amountB: bigint;
    feesOwed0: bigint;
    feesOwed1: bigint;
    collectedFees0: bigint;
    collectedFees1: bigint;
  } {
    const totals = this.virtualManager.getTotals();
    return {
      amountA: totals.amountA || 0n,
      amountB: totals.amountB || 0n,
      feesOwed0: totals.feesOwed0 || 0n,
      feesOwed1: totals.feesOwed1 || 0n,
      collectedFees0: totals.collectedFees0 || 0n,
      collectedFees1: totals.collectedFees1 || 0n,
    };
  }

  getAllPositions(): any[] {
    return this.virtualManager.getAllPositions();
  }

  getActivePositions(): any[] {
    return this.virtualManager
      .getAllPositions()
      .filter((p) => p.liquidity > 0n);
  }
}

/**
 * Pool 价格提供者适配器
 * 将 Pool 适配为 FeeCollectionManager 需要的 PriceProvider 接口
 */
export class PoolPriceProviderAdapter implements PriceProvider {
  constructor(private pool: Pool) {}

  getCurrentPrice(): number {
    return this.pool.price;
  }

  getCurrentTick(): number {
    return this.pool.tickCurrent;
  }
}
