import { Pool } from "../pool";
import { VirtualPositionManager } from "../virtual_position_mgr";

export interface ThreeBandPydramidConfig {
  // Position widths in ticks
  position1WidthTicks: number; // Narrow position (default: 2 ticks)
  position2WidthTicks: number; // Medium position (default: 6 ticks)
  position3WidthTicks: number; // Wide position (default: 8 ticks)

  // Fund allocation percentages (should sum to 100)
  position1AllocPct: number; // Default: 30%
  position2AllocPct: number; // Default: 30%
  position3AllocPct: number; // Default: 40%

  // Rebalancing controls for position 1 (narrow position only)
  cooldownMs: number; // Minimum time between rebalances
  maxRebalancePer24Hours: number; // Max rebalances in 24-hour window

  // Action costs
  actionCostTokenA: number;
  actionCostTokenB: number;

  // Slippage tolerance
  maxSwapSlippageBps: number;
  bootstrapMaxSwapSlippageBps: number;
  bootstrapAttempts: number;
}

type PositionState = {
  id: string;
  tickLower: number;
  tickUpper: number;
  widthTicks: number;
  allocPct: number;
  canRebalance: boolean; // Only position 1 can rebalance
  lastRebalanceTime: number;
};

export type PydramidAction =
  | { action: "none" | "wait"; message: string }
  | {
      action: "create" | "rebalance";
      message: string;
      positions: PositionState[];
    };

export class ThreeBandPydramidStrategy {
  private readonly manager: VirtualPositionManager;
  private readonly pool: Pool;
  private config: ThreeBandPydramidConfig;

  private positions: PositionState[] = [];
  private rebalanceHistory: number[] = []; // Timestamps of rebalances
  private overrideNow: number | null = null;
  private lastCheckTime = 0;

  constructor(
    manager: VirtualPositionManager,
    pool: Pool,
    config: Partial<ThreeBandPydramidConfig> = {}
  ) {
    this.manager = manager;
    this.pool = pool;

    // Validate allocation percentages
    const alloc1 = config.position1AllocPct ?? 30;
    const alloc2 = config.position2AllocPct ?? 30;
    const alloc3 = config.position3AllocPct ?? 40;
    const totalAlloc = alloc1 + alloc2 + alloc3;

    if (Math.abs(totalAlloc - 100) > 0.01) {
      console.warn(
        `[Pydium] Allocation percentages sum to ${totalAlloc}%, normalizing to 100%`
      );
    }

    this.config = {
      position1WidthTicks: config.position1WidthTicks ?? 2,
      position2WidthTicks: config.position2WidthTicks ?? 6,
      position3WidthTicks: config.position3WidthTicks ?? 8,
      position1AllocPct: alloc1,
      position2AllocPct: alloc2,
      position3AllocPct: alloc3,
      cooldownMs: config.cooldownMs ?? 5 * 60_000, // 5 minutes default
      maxRebalancePer24Hours: config.maxRebalancePer24Hours ?? 48,
      actionCostTokenA: config.actionCostTokenA ?? 0,
      actionCostTokenB: config.actionCostTokenB ?? 5000,
      maxSwapSlippageBps: config.maxSwapSlippageBps ?? 50,
      bootstrapMaxSwapSlippageBps: config.bootstrapMaxSwapSlippageBps ?? 200,
      bootstrapAttempts: config.bootstrapAttempts ?? 3,
    };
  }

  initialize(): PydramidAction {
    const now = this.now();
    this.lastCheckTime = now;
    return this.createInitialPositions();
  }

  execute(): PydramidAction {
    if (this.positions.length === 0) {
      return this.createInitialPositions();
    }

    const now = this.now();
    const currentTick = this.pool.tickCurrent;

    // Check if position 1 (narrow) needs rebalancing
    const pos1 = this.positions[0];
    if (!pos1) {
      return { action: "none", message: "No positions available" };
    }

    // Check if position 1 is out of range
    const pos1InRange =
      currentTick >= pos1.tickLower && currentTick < pos1.tickUpper;

    if (pos1InRange) {
      return {
        action: "none",
        message: `Narrow position in range at tick ${currentTick}`,
      };
    }

    // Position 1 is out of range - check if we can rebalance
    const canRebalance = this.canRebalancePosition1(now);

    if (!canRebalance.allowed) {
      return {
        action: "wait",
        message: canRebalance.reason,
      };
    }

    // Perform rebalance
    const success = this.rebalancePosition1(now, currentTick);

    if (!success) {
      return {
        action: "none",
        message: "Failed to rebalance position 1",
      };
    }

    return {
      action: "rebalance",
      message: `Rebalanced narrow position to cover tick ${currentTick}`,
      positions: this.getPositions(),
    };
  }

  setCurrentTime(timestamp: number | null) {
    this.overrideNow = timestamp;
  }

  getPositions(): PositionState[] {
    return this.positions.map((p) => ({ ...p }));
  }

  private now(): number {
    return this.overrideNow ?? Date.now();
  }

  private createInitialPositions(): PydramidAction {
    // Clear any existing positions
    for (const pos of this.positions) {
      try {
        this.manager.closePosition(pos.id);
      } catch (err) {
        // Ignore errors on cleanup
      }
    }
    this.positions = [];

    const currentTick = this.pool.tickCurrent;
    const now = this.now();

    // Get total available capital
    const totals = this.manager.getTotals();
    const totalCapitalA = totals.cashAmountA ?? totals.amountA;
    const totalCapitalB = totals.cashAmountB ?? totals.amountB;

    // Calculate allocations (normalize to sum to 100%)
    const totalPct =
      this.config.position1AllocPct +
      this.config.position2AllocPct +
      this.config.position3AllocPct;
    const alloc1 = this.config.position1AllocPct / totalPct;
    const alloc2 = this.config.position2AllocPct / totalPct;
    const alloc3 = this.config.position3AllocPct / totalPct;

    // Define three positions centered around current tick
    const positionSpecs = [
      {
        widthTicks: this.config.position1WidthTicks,
        allocPct: alloc1,
        canRebalance: true,
      },
      {
        widthTicks: this.config.position2WidthTicks,
        allocPct: alloc2,
        canRebalance: false,
      },
      {
        widthTicks: this.config.position3WidthTicks,
        allocPct: alloc3,
        canRebalance: false,
      },
    ];

    const opened: PositionState[] = [];

    for (const spec of positionSpecs) {
      // Center each position around current tick
      const halfWidth = Math.floor(spec.widthTicks / 2);
      const tickLower = currentTick - halfWidth;
      const tickUpper = tickLower + spec.widthTicks;

      // Calculate capital for this position
      const capitalA = BigInt(
        Math.floor(Number(totalCapitalA) * spec.allocPct)
      );
      const capitalB = BigInt(
        Math.floor(Number(totalCapitalB) * spec.allocPct)
      );

      try {
        const posId = this.openPosition(
          tickLower,
          tickUpper,
          capitalA,
          capitalB,
          now
        );

        opened.push({
          id: posId,
          tickLower,
          tickUpper,
          widthTicks: spec.widthTicks,
          allocPct: spec.allocPct,
          canRebalance: spec.canRebalance,
          lastRebalanceTime: now,
        });
      } catch (error) {
        console.warn(
          `[Pydium] Failed to open position [${tickLower},${tickUpper}]: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
    }

    this.positions = opened;

    if (opened.length === 0) {
      return {
        action: "none",
        message: "Failed to open any positions",
      };
    }

    return {
      action: "create",
      message: `Created ${opened.length} positions (widths: ${positionSpecs
        .map((s) => s.widthTicks)
        .join(", ")} ticks)`,
      positions: this.getPositions(),
    };
  }

  private canRebalancePosition1(now: number): {
    allowed: boolean;
    reason: string;
  } {
    const pos1 = this.positions[0];
    if (!pos1) {
      return { allowed: false, reason: "Position 1 not found" };
    }

    // Check cooldown
    const timeSinceLastRebalance = now - pos1.lastRebalanceTime;
    if (timeSinceLastRebalance < this.config.cooldownMs) {
      const remainingMs = this.config.cooldownMs - timeSinceLastRebalance;
      return {
        allowed: false,
        reason: `Cooldown active: ${Math.ceil(remainingMs / 1000)}s remaining`,
      };
    }

    // Check 24-hour rebalance limit
    const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
    const recentRebalances = this.rebalanceHistory.filter(
      (ts) => ts > twentyFourHoursAgo
    );

    if (recentRebalances.length >= this.config.maxRebalancePer24Hours) {
      return {
        allowed: false,
        reason: `Max rebalances reached: ${recentRebalances.length}/${this.config.maxRebalancePer24Hours} in 24h`,
      };
    }

    return { allowed: true, reason: "" };
  }

  private rebalancePosition1(now: number, currentTick: number): boolean {
    const pos1 = this.positions[0];
    if (!pos1) return false;

    try {
      // Remove old position
      this.manager.closePosition(pos1.id);

      // Calculate new range centered on current tick
      const halfWidth = Math.floor(pos1.widthTicks / 2);
      const newTickLower = currentTick - halfWidth;
      const newTickUpper = newTickLower + pos1.widthTicks;

      // Get available capital (should be mostly from closed position)
      const totals = this.manager.getTotals();
      const availableA = totals.cashAmountA ?? 0n;
      const availableB = totals.cashAmountB ?? 0n;

      // Open new position
      const newPosId = this.openPosition(
        newTickLower,
        newTickUpper,
        availableA,
        availableB,
        now
      );

      // Update position state
      pos1.id = newPosId;
      pos1.tickLower = newTickLower;
      pos1.tickUpper = newTickUpper;
      pos1.lastRebalanceTime = now;

      // Record rebalance in history
      this.rebalanceHistory.push(now);

      // Clean up old rebalance history (keep only last 24 hours)
      const twentyFourHoursAgo = now - 24 * 60 * 60 * 1000;
      this.rebalanceHistory = this.rebalanceHistory.filter(
        (ts) => ts > twentyFourHoursAgo
      );

      return true;
    } catch (error) {
      console.error(
        `[Pydium] Rebalance failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return false;
    }
  }

  private openPosition(
    tickLower: number,
    tickUpper: number,
    maxAmountA: bigint,
    maxAmountB: bigint,
    timestamp: number
  ): string {
    const positionId = this.manager.newPositionId();
    this.manager.createPosition(
      positionId,
      tickLower,
      tickUpper,
      maxAmountA,
      maxAmountB,
      timestamp
    );
    return positionId;
    // const slippages = this.buildSlippageAttempts();
    // let lastError: Error | null = null;

    // for (const slippage of slippages) {
    //   try {
    //     const result = this.manager.addLiquidityWithSwap(
    //       tickLower,
    //       tickUpper,
    //       maxAmountA,
    //       maxAmountB,
    //       slippage,
    //       this.getActionCost()
    //     );

    //     return result.positionId;
    //   } catch (err) {
    //     lastError = err as Error;
    //   }
    // }

    // throw new Error(
    //   `Failed to open position [${tickLower}, ${tickUpper}]: ${
    //     lastError?.message ?? "unknown error"
    //   }`
    // );
  }

  private buildSlippageAttempts(): number[] {
    const attempts = new Set<number>();
    attempts.add(Math.max(1, this.config.maxSwapSlippageBps));
    attempts.add(Math.max(1, this.config.bootstrapMaxSwapSlippageBps));

    let current = Math.max(1, this.config.bootstrapMaxSwapSlippageBps);
    for (let i = 1; i < this.config.bootstrapAttempts; i++) {
      current = Math.min(10_000, current * 2);
      attempts.add(current);
    }

    return Array.from(attempts).sort((a, b) => a - b);
  }

  private getActionCost() {
    return {
      tokenA:
        this.config.actionCostTokenA > 0
          ? this.config.actionCostTokenA
          : undefined,
      tokenB:
        this.config.actionCostTokenB > 0
          ? this.config.actionCostTokenB
          : undefined,
    };
  }
}
