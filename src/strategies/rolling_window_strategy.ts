import type { IStrategy, IPositionManager, IPool, BacktestContext } from "../types";

/**
 * Rolling Window Strategy
 * 
 * Maintains 3 equal-width positions that form a rolling window around the current price.
 * Only rebalances the furthest position when all 3 are out of range.
 * 
 * Example with width=2 ticks, current price at tick 0:
 *   Pos 0: [-2, 0]   ← Below
 *   Pos 1: [0, 2]    ← Center (contains current price)
 *   Pos 2: [2, 4]    ← Above
 * 
 * When price moves and all positions are out of range:
 *   - Find the furthest position from current price
 *   - Rebalance only that position to cover the current price
 *   - Other 2 positions remain unchanged
 *   - Respect cooldown period before rebalancing same position again
 */

interface RollingWindowConfig {
  positionWidth: number;        // Width of each position in ticks (must be multiple of tickSpacing)
  outsideDurationMs: number;    // How long all positions must be out of range before rebalancing
  cooldownMs: number;           // Cooldown period after rebalancing a position
  initialAllocation: bigint;    // Initial allocation per position (equal split)
  tickSpacing: number;          // Tick spacing for the pool
}

interface PositionState {
  id: string;
  lower: number;
  upper: number;
  lastRebalanceTime: number;
  isInCooldown: boolean;
  isOpened: boolean; // Track if position is actually opened in the manager
}

export class RollingWindowStrategy implements IStrategy {
  private config: RollingWindowConfig;
  private tickSpacing: number;
  
  private positions: Map<string, PositionState> = new Map();
  private allOutOfRangeStartTime: number = 0;
  private currentTime: number = 0;

  constructor(config: Partial<RollingWindowConfig>) {
    // Validate required config
    if (!config.positionWidth) throw new Error("positionWidth is required");
    if (!config.outsideDurationMs) throw new Error("outsideDurationMs is required");
    if (!config.cooldownMs) throw new Error("cooldownMs is required");
    if (!config.initialAllocation) throw new Error("initialAllocation is required");
    if (!config.tickSpacing) throw new Error("tickSpacing is required");

    this.config = config as RollingWindowConfig;
    this.tickSpacing = config.tickSpacing;

    // Validate position width is aligned to tick spacing
    if (this.config.positionWidth % this.tickSpacing !== 0) {
      throw new Error(
        `Position width ${this.config.positionWidth} must be a multiple of tickSpacing ${this.tickSpacing}`
      );
    }
  }

  getName(): string {
    return "rolling-window";
  }

  async onStart(ctx: BacktestContext): Promise<void> {
    this.currentTime = ctx.currentTime;
    const currentTick = ctx.pool.getTick();

    console.log(`[STRATEGY] [rolling_window] [started]`);
    console.log(`[CONFIG] [position_width] [${this.config.positionWidth} ticks]`);
    console.log(`[CONFIG] [outside_duration] [${this.config.outsideDurationMs} ms] [${this.config.outsideDurationMs / 1000} seconds]`);
    console.log(`[CONFIG] [cooldown] [${this.config.cooldownMs} ms] [${this.config.cooldownMs / 1000} seconds]`);
    console.log(`[CONFIG] [current_tick] [${currentTick}]`);

    // Initialize 3 positions centered around current price
    await this.initializePositions(currentTick, ctx);
  }

  private async initializePositions(currentTick: number, ctx: BacktestContext): Promise<void> {
    const width = this.config.positionWidth;
    
    // Align current tick to tick spacing
    const alignedTick = this.alignTick(currentTick);
    
    // Get initial balances
    const initialBalance0 = ctx.positionManager.getBalance0();
    const initialBalance1 = ctx.positionManager.getBalance1();
    
    console.log(`[STRATEGY] [initial_balances] [balance0=${initialBalance0}] [balance1=${initialBalance1}]`);

    // Start with only the CENTER position (pos1) that contains the current price
    // The side positions (pos0 and pos2) will be opened dynamically as we accumulate tokens
    const centerLower = alignedTick;
    const centerUpper = alignedTick + width;

    this.positions.set("pos1", {
      id: "pos1",
      lower: centerLower,
      upper: centerUpper,
      lastRebalanceTime: this.currentTime,
      isInCooldown: false,
      isOpened: true,
    });

    ctx.positionManager.openPosition("pos1", centerLower, centerUpper);
    
    // Add all available liquidity to the center position
    await ctx.positionManager.addLiquidity(
      "pos1",
      initialBalance0,
      initialBalance1
    );

    console.log(`[STRATEGY] [init_position] [id=pos1] [range=${centerLower}:${centerUpper}] [center]`);
    
    // Initialize pos0 and pos2 as placeholders (not opened yet)
    this.positions.set("pos0", {
      id: "pos0",
      lower: alignedTick - width,
      upper: alignedTick,
      lastRebalanceTime: this.currentTime,
      isInCooldown: true, // Mark as cooldown to prevent immediate opening
      isOpened: false,
    });
    
    this.positions.set("pos2", {
      id: "pos2",
      lower: alignedTick + width,
      upper: alignedTick + 2 * width,
      lastRebalanceTime: this.currentTime,
      isInCooldown: true, // Mark as cooldown to prevent immediate opening
      isOpened: false,
    });
    
    console.log(`[STRATEGY] [init_placeholder] [id=pos0] [range=${alignedTick - width}:${alignedTick}] [below]`);
    console.log(`[STRATEGY] [init_placeholder] [id=pos2] [range=${alignedTick + width}:${alignedTick + 2 * width}] [above]`);
  }

  async onTick(timestamp: number, ctx: BacktestContext): Promise<void> {
    this.currentTime = timestamp;
    const currentTick = ctx.pool.getTick();

    // Update cooldown status
    this.updateCooldowns();

    // Try to open unopened positions if we have available balance
    await this.tryOpenUnopenedPositions(ctx);

    // Check if all OPENED positions are out of range
    const allOutOfRange = this.areAllOpenedPositionsOutOfRange(currentTick);

    if (allOutOfRange) {
      if (this.allOutOfRangeStartTime === 0) {
        this.allOutOfRangeStartTime = timestamp;
      }

      const durationOutOfRange = timestamp - this.allOutOfRangeStartTime;

      // Check if we've been out of range long enough
      if (durationOutOfRange >= this.config.outsideDurationMs) {
        await this.rebalanceFurthestPosition(currentTick, ctx);
        this.allOutOfRangeStartTime = 0; // Reset timer
      }
    } else {
      // At least one position is in range, reset timer
      this.allOutOfRangeStartTime = 0;
    }
  }

  private async tryOpenUnopenedPositions(ctx: BacktestContext): Promise<void> {
    const balance0 = ctx.positionManager.getBalance0();
    const balance1 = ctx.positionManager.getBalance1();
    
    // Only try to open if we have a reasonable balance (e.g., > 1% of initial allocation)
    const minBalance = this.config.initialAllocation / 100n;
    
    if (balance0 < minBalance && balance1 < minBalance) {
      return; // Not enough balance to open new positions
    }

    for (const pos of this.positions.values()) {
      if (!pos.isOpened && !pos.isInCooldown) {
        // Try to open this position
        console.log(`[STRATEGY] [opening_position] [id=${pos.id}] [range=${pos.lower}:${pos.upper}] [balance0=${balance0}] [balance1=${balance1}]`);
        
        ctx.positionManager.openPosition(pos.id, pos.lower, pos.upper);
        
        await ctx.positionManager.addLiquidity(
          pos.id,
          balance0,
          balance1
        );
        
        pos.isOpened = true;
        console.log(`[STRATEGY] [opened_position] [id=${pos.id}] [range=${pos.lower}:${pos.upper}]`);
        
        // Only open one position per tick to avoid draining all balance at once
        break;
      }
    }
  }

  private areAllOpenedPositionsOutOfRange(currentTick: number): boolean {
    let hasOpenedPosition = false;
    
    for (const pos of this.positions.values()) {
      if (!pos.isOpened) {
        continue; // Skip unopened positions
      }
      
      hasOpenedPosition = true;
      
      if (currentTick >= pos.lower && currentTick < pos.upper) {
        return false; // At least one opened position is in range
      }
    }
    
    // If no positions are opened, return false to prevent rebalancing
    return hasOpenedPosition;
  }

  private updateCooldowns(): void {
    for (const pos of this.positions.values()) {
      if (pos.isInCooldown) {
        const timeSinceRebalance = this.currentTime - pos.lastRebalanceTime;
        if (timeSinceRebalance >= this.config.cooldownMs) {
          pos.isInCooldown = false;
        }
      }
    }
  }

  private async rebalanceFurthestPosition(currentTick: number, ctx: BacktestContext): Promise<void> {
    // Find the furthest OPENED position that is not in cooldown
    let furthestPos: PositionState | null = null;
    let maxDistance = -1;

    for (const pos of this.positions.values()) {
      if (!pos.isOpened || pos.isInCooldown) {
        continue; // Skip unopened or cooldown positions
      }

      // Calculate distance from current tick to position
      const distance = this.calculateDistance(currentTick, pos.lower, pos.upper);
      
      if (distance > maxDistance) {
        maxDistance = distance;
        furthestPos = pos;
      }
    }

    if (!furthestPos) {
      console.log(`[STRATEGY] [rebalance_skipped] [all_in_cooldown_or_unopened]`);
      return;
    }

    console.log(`[STRATEGY] [rebalancing] [position=${furthestPos.id}] [old_range=${furthestPos.lower}:${furthestPos.upper}] [current_tick=${currentTick}] [distance=${maxDistance}]`);

    // Close the old position
    const withdrawnAmounts = ctx.positionManager.closePosition(furthestPos.id);
    console.log(`[STRATEGY] [withdrawn] [position=${furthestPos.id}] [amount0=${withdrawnAmounts.amount0}] [amount1=${withdrawnAmounts.amount1}]`);

    // Calculate new range centered around current tick
    const alignedTick = this.alignTick(currentTick);
    const halfWidth = Math.floor(this.config.positionWidth / 2);
    
    // Align to tick spacing
    const newLower = this.alignTick(alignedTick - halfWidth);
    const newUpper = this.alignTick(alignedTick + halfWidth);

    // Ensure width is correct (adjust if needed due to rounding)
    const actualWidth = newUpper - newLower;
    if (actualWidth !== this.config.positionWidth) {
      // Adjust upper to maintain exact width
      const adjustedUpper = newLower + this.config.positionWidth;
      furthestPos.lower = newLower;
      furthestPos.upper = adjustedUpper;
    } else {
      furthestPos.lower = newLower;
      furthestPos.upper = newUpper;
    }

    furthestPos.lastRebalanceTime = this.currentTime;
    furthestPos.isInCooldown = true;

    console.log(`[STRATEGY] [new_range] [position=${furthestPos.id}] [range=${furthestPos.lower}:${furthestPos.upper}]`);

    // Reopen position with new range
    ctx.positionManager.openPosition(furthestPos.id, furthestPos.lower, furthestPos.upper);

    // Add liquidity with withdrawn amounts
    await ctx.positionManager.addLiquidity(
      furthestPos.id,
      withdrawnAmounts.amount0,
      withdrawnAmounts.amount1
    );

    console.log(`[STRATEGY] [rebalanced] [position=${furthestPos.id}] [new_range=${furthestPos.lower}:${furthestPos.upper}]`);
  }

  private calculateDistance(currentTick: number, lower: number, upper: number): number {
    if (currentTick < lower) {
      // Price is below position
      return lower - currentTick;
    } else if (currentTick >= upper) {
      // Price is above position
      return currentTick - upper;
    } else {
      // Price is in range (should not happen when all are out of range)
      return 0;
    }
  }

  private alignTick(tick: number): number {
    return Math.floor(tick / this.tickSpacing) * this.tickSpacing;
  }

  async onSwapEvent(timestamp: number, ctx: BacktestContext): Promise<void> {
    // No action needed on swap events
  }

  async onEnd(ctx: BacktestContext): Promise<void> {
    console.log(`[STRATEGY] [rolling_window] [ended]`);
    
    // Close all opened positions
    for (const pos of this.positions.values()) {
      if (pos.isOpened) {
        ctx.positionManager.closePosition(pos.id);
        console.log(`[STRATEGY] [closed] [position=${pos.id}]`);
      } else {
        console.log(`[STRATEGY] [skipped_close] [position=${pos.id}] [never_opened]`);
      }
    }
  }
}

