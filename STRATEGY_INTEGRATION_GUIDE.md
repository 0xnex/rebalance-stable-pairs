# Strategy Integration Guide

This guide explains how to create and test trading strategies with the backtest framework.

## Table of Contents
- [Strategy Interface](#strategy-interface)
- [Quick Start: Create a Strategy](#quick-start-create-a-strategy)
- [Testing Your Strategy](#testing-your-strategy)
- [Strategy Examples](#strategy-examples)
- [Best Practices](#best-practices)

---

## Strategy Interface

All strategies must implement the `IStrategy` interface:

```typescript
interface IStrategy {
  onStart(context: BacktestContext): void;
  onEnd(context: BacktestContext): void;
  onTick(timestamp: number, context: BacktestContext): void;
}
```

### BacktestContext

The context provides read-only access to the backtest state:

```typescript
interface BacktestContext {
  readonly pool: IPool;              // Pool state (price, liquidity, tick)
  readonly positionManager: IPositionManager;  // Position management
  readonly currentTime: number;      // Current timestamp in ms
}
```

### Key Methods You Can Use

**From `pool` (IPool):**
- `pool.getCurrentTick()`: Get current tick
- `pool.getCurrentPrice()`: Get current price
- `pool.getSqrtPriceX64()`: Get sqrt price (X64 format)
- `pool.getLiquidity()`: Get current liquidity
- `pool.getToken0Name()`: Get token0 name
- `pool.getToken1Name()`: Get token1 name

**From `positionManager` (IPositionManager):**
- `manager.openPosition(id, tickLower, tickUpper)`: Open a position
- `manager.addLiquidity(id, amount0, amount1)`: Add liquidity to a position
- `manager.removeLiquidity(id, liquidity)`: Remove liquidity from a position
- `manager.closePosition(id)`: Close a position
- `manager.getPosition(id)`: Get position details
- `manager.getAllPositions()`: Get all positions
- `manager.getBalance0()`: Get available token0 balance in wallet
- `manager.getBalance1()`: Get available token1 balance in wallet
- `manager.getWallet()`: Get the fund's wallet (implements IWallet)
- `manager.claimFee(id)`: Claim fees from a position (adds to wallet)

---

## Quick Start: Create a Strategy

### Step 1: Create Your Strategy File

Create a new file in `src/strategies/` (e.g., `my_strategy.ts`):

```typescript
import type { IStrategy, BacktestContext } from "../types";

export class MyStrategy implements IStrategy {
  onStart(context: BacktestContext): void {
    console.log("[STRATEGY] [my_strategy] [started]");
    console.log(`[STRATEGY] [initial_tick] [${context.pool.getCurrentTick()}]`);
    console.log(`[STRATEGY] [initial_price] [${context.pool.getCurrentPrice()}]`);
    
    // Open initial positions
    const tick = context.pool.getCurrentTick();
    const tickSpacing = 10;
    
    // Open a position centered around current price
    const tickLower = Math.floor(tick / tickSpacing) * tickSpacing - 100;
    const tickUpper = Math.floor(tick / tickSpacing) * tickSpacing + 100;
    
    context.positionManager.openPosition("position-1", tickLower, tickUpper);
    context.positionManager.addLiquidity(
      "position-1",
      5_000_000n,  // amount0
      5_000_000n   // amount1
    );
  }

  onTick(timestamp: number, context: BacktestContext): void {
    // Called every second (or every tickInterval)
    // Implement your rebalancing logic here
    
    const currentTick = context.pool.getCurrentTick();
    const positions = context.positionManager.getAllPositions();
    
    // Example: Check if positions are out of range
    for (const pos of positions) {
      if (pos.status === "open") {
        const inRange = currentTick >= pos.tickLower && currentTick < pos.tickUpper;
        if (!inRange) {
          console.log(`[STRATEGY] [position_out_of_range] [id=${pos.id}] [tick=${currentTick}]`);
          // Rebalance logic here
        }
      }
    }
  }

  onEnd(context: BacktestContext): void {
    console.log("[STRATEGY] [my_strategy] [completed]");
    
    const finalTick = context.pool.getCurrentTick();
    const finalPrice = context.pool.getCurrentPrice();
    const positions = context.positionManager.getAllPositions();
    
    console.log(`[STRATEGY] [final_tick] [${finalTick}]`);
    console.log(`[STRATEGY] [final_price] [${finalPrice}]`);
    console.log(`[STRATEGY] [total_positions] [${positions.length}]`);
  }
}
```

### Step 2: Integrate with Backtest

Modify `src/backtest.ts` to use your strategy:

```typescript
// Import your strategy
import { MyStrategy } from "./strategies/my_strategy";

// In runBacktest(), replace:
const strategy = new NoOpStrategy();

// With:
const strategy = new MyStrategy();
```

### Step 3: Run the Backtest

```bash
bun run src/backtest.ts \
  --poolId 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 \
  --start "2025-08-20T00:00:00Z" \
  --end "2025-08-21T00:00:00Z" \
  --token0 USDC \
  --token1 USDT \
  --init0 10000000 \
  --init1 10000000
```

---

## Testing Your Strategy

### Method 1: Direct Integration (for development)

1. **Edit `backtest.ts`** to import and use your strategy
2. **Run backtest** with your parameters
3. **Check CSV outputs** in `./backtest-results/`

### Method 2: Strategy Factory Pattern (for multiple strategies)

Create a strategy loader in `backtest.ts`:

```typescript
// Add CLI argument for strategy selection
interface BacktestArgs {
  // ... existing fields
  strategy?: string;
}

// Add to parseArgs():
case "--strategy":
  if (next) {
    parsed.strategy = next;
    i++;
  }
  break;

// Create strategy factory
function createStrategy(name?: string): IStrategy {
  switch (name) {
    case "my_strategy":
      return new MyStrategy();
    case "three_band":
      return new ThreeBandStrategy();
    // Add more strategies here
    default:
      return new NoOpStrategy();
  }
}

// In runBacktest():
const strategy = createStrategy(args.strategy);
```

Then run with:
```bash
bun run src/backtest.ts \
  --strategy my_strategy \
  --poolId 0x737ec... \
  --start "2025-08-20T00:00:00Z" \
  --end "2025-08-21T00:00:00Z"
```

### Method 3: Separate Entry Scripts (recommended for production)

Create strategy-specific entry scripts:

**`scripts/backtest_my_strategy.ts`:**
```typescript
import { MyStrategy } from "../src/strategies/my_strategy";
import { runBacktestWithStrategy } from "../src/backtest";

// Run backtest with your strategy
await runBacktestWithStrategy(new MyStrategy(), {
  poolId: "0x737ec...",
  startTime: new Date("2025-08-20T00:00:00Z"),
  endTime: new Date("2025-08-21T00:00:00Z"),
  // ... other config
});
```

---

## Strategy Examples

### Important: Opening Positions

Positions are opened in **two steps**:

1. **`openPosition(id, tickLower, tickUpper)`** - Creates the position
2. **`addLiquidity(id, amount0, amount1)`** - Deposits funds into the position

This two-step approach gives you control over:
- When to create positions vs when to fund them
- How much capital to allocate to each position
- Incremental liquidity additions to existing positions

The **wallet** automatically tracks available balance and is updated when you add/remove liquidity.

---

### Example 1: Simple Rebalancer

Rebalance when price moves out of range:

```typescript
export class SimpleRebalancer implements IStrategy {
  private positionId = "main-position";
  private rangeWidth = 200; // ticks

  onStart(context: BacktestContext): void {
    this.openCenteredPosition(context);
  }

  onTick(timestamp: number, context: BacktestContext): void {
    const pos = context.positionManager.getPosition(this.positionId);
    const tick = context.pool.getCurrentTick();
    
    if (pos && tick < pos.tickLower || tick >= pos.tickUpper) {
      // Out of range - rebalance
      context.positionManager.closePosition(this.positionId);
      this.openCenteredPosition(context);
      console.log(`[STRATEGY] [rebalanced] [tick=${tick}] [time=${new Date(timestamp).toISOString()}]`);
    }
  }

  onEnd(context: BacktestContext): void {
    // Cleanup
  }

  private openCenteredPosition(context: BacktestContext): void {
    const tick = context.pool.getCurrentTick();
    const tickSpacing = 10;
    const alignedTick = Math.floor(tick / tickSpacing) * tickSpacing;
    
    const balance0 = context.positionManager.getBalance0();
    const balance1 = context.positionManager.getBalance1();
    
    context.positionManager.openPosition(
      this.positionId,
      alignedTick - this.rangeWidth / 2,
      alignedTick + this.rangeWidth / 2
    );
    context.positionManager.addLiquidity(
      this.positionId,
      balance0 / 2n,
      balance1 / 2n
    );
  }
}
```

### Example 2: Multi-Band Strategy

Multiple positions at different ranges:

```typescript
export class MultiBandStrategy implements IStrategy {
  private bands = [
    { id: "narrow", widthTicks: 100, allocation: 0.5 },
    { id: "wide", widthTicks: 300, allocation: 0.3 },
    { id: "ultra-wide", widthTicks: 500, allocation: 0.2 },
  ];

  onStart(context: BacktestContext): void {
    const tick = context.pool.getCurrentTick();
    const balance0 = context.positionManager.getBalance0();
    const balance1 = context.positionManager.getBalance1();
    
    for (const band of this.bands) {
      const amount0 = (balance0 * BigInt(Math.floor(band.allocation * 100))) / 100n;
      const amount1 = (balance1 * BigInt(Math.floor(band.allocation * 100))) / 100n;
      
      context.positionManager.openPosition(
        band.id,
        tick - band.widthTicks / 2,
        tick + band.widthTicks / 2
      );
      context.positionManager.addLiquidity(
        band.id,
        amount0,
        amount1
      );
    }
  }

  onTick(timestamp: number, context: BacktestContext): void {
    // Check each band and rebalance if needed
    for (const band of this.bands) {
      this.checkAndRebalanceBand(band, context);
    }
  }

  onEnd(context: BacktestContext): void {
    // Close all positions
    for (const band of this.bands) {
      context.positionManager.closePosition(band.id);
    }
  }

  private checkAndRebalanceBand(band: any, context: BacktestContext): void {
    const pos = context.positionManager.getPosition(band.id);
    const tick = context.pool.getCurrentTick();
    
    if (pos && (tick < pos.lower || tick >= pos.upper)) {
      // Rebalance this band
      const { amount0, amount1 } = context.positionManager.closePosition(band.id);
      
      // Re-open centered
      context.positionManager.openPosition(
        band.id,
        tick - band.widthTicks / 2,
        tick + band.widthTicks / 2
      );
      context.positionManager.addLiquidity(
        band.id,
        amount0,
        amount1
      );
    }
  }
}
```

### Example 3: Time-Based Strategy

Rebalance at fixed intervals:

```typescript
export class TimeBasedStrategy implements IStrategy {
  private lastRebalanceTime = 0;
  private rebalanceIntervalMs = 3600 * 1000; // 1 hour

  onStart(context: BacktestContext): void {
    this.rebalance(context);
    this.lastRebalanceTime = context.currentTime;
  }

  onTick(timestamp: number, context: BacktestContext): void {
    const elapsed = timestamp - this.lastRebalanceTime;
    
    if (elapsed >= this.rebalanceIntervalMs) {
      this.rebalance(context);
      this.lastRebalanceTime = timestamp;
      console.log(`[STRATEGY] [scheduled_rebalance] [time=${new Date(timestamp).toISOString()}]`);
    }
  }

  onEnd(context: BacktestContext): void {
    // Final stats
  }

  private rebalance(context: BacktestContext): void {
    // Close all positions
    const positions = context.positionManager.getAllPositions();
    for (const pos of positions) {
      if (!pos.isClosed) {
        context.positionManager.closePosition(pos.id);
      }
    }
    
    // Open new position
    const tick = context.pool.getCurrentTick();
    const balance0 = context.positionManager.getBalance0();
    const balance1 = context.positionManager.getBalance1();
    
    context.positionManager.openPosition(
      `pos-${context.currentTime}`,
      tick - 150,
      tick + 150
    );
    context.positionManager.addLiquidity(
      `pos-${context.currentTime}`,
      balance0 / 2n,
      balance1 / 2n
    );
  }
}
```

---

## Best Practices

### 1. **Use Structured Logging**

Follow the `[LEVEL] [component] [state] [key=value]` format:

```typescript
console.log("[STRATEGY] [my_strategy] [position_opened] [id=pos-1] [tick=100]");
console.log("[STRATEGY] [rebalancer] [out_of_range] [current_tick=150] [range=50-100]");
```

### 2. **Handle Edge Cases**

- Check position exists before closing
- Verify sufficient balance before opening
- Validate tick alignment with tickSpacing

```typescript
onTick(timestamp: number, context: BacktestContext): void {
  const balance0 = context.positionManager.getBalance0();
  const balance1 = context.positionManager.getBalance1();
  
  if (balance0 < 1000n || balance1 < 1000n) {
    console.log("[STRATEGY] [insufficient_balance] [skipping]");
    return;
  }
  
  // Proceed with strategy logic
}
```

### 3. **Track Strategy Metrics**

Keep internal counters for debugging:

```typescript
export class MyStrategy implements IStrategy {
  private rebalanceCount = 0;
  private positionsOpened = 0;
  
  onEnd(context: BacktestContext): void {
    console.log(`[STRATEGY] [stats] [rebalances=${this.rebalanceCount}]`);
    console.log(`[STRATEGY] [stats] [positions_opened=${this.positionsOpened}]`);
  }
}
```

### 4. **Test with Different Parameters**

Run multiple backtests with varying:
- Time periods (bull vs bear markets)
- Initial balances
- Tick ranges
- Rebalance thresholds

### 5. **Analyze Performance Metrics**

After backtest, check the CSV outputs:
- `fund_performance_*.csv`: Overall PnL, ROI, fees
- `position_performance_*.csv`: Per-position metrics

Compare different strategies by their:
- Total ROI
- Fee income
- Slippage costs
- Swap frequency

### 6. **Use Helper Functions**

Create reusable utilities:

```typescript
class StrategyHelpers {
  static alignTickToSpacing(tick: number, spacing: number): number {
    return Math.floor(tick / spacing) * spacing;
  }
  
  static isPositionInRange(position: Position, currentTick: number): boolean {
    return currentTick >= position.tickLower && currentTick < position.tickUpper;
  }
  
  static calculateAllocation(balance: bigint, percentage: number): bigint {
    return (balance * BigInt(Math.floor(percentage * 100))) / 100n;
  }
}
```

---

## Summary

1. **Create** a strategy class implementing `IStrategy`
2. **Implement** `onStart()`, `onTick()`, and `onEnd()` methods
3. **Use** `BacktestContext` to access pool and position manager
4. **Integrate** your strategy into `backtest.ts`
5. **Run** backtest with CLI parameters
6. **Analyze** CSV outputs for performance

For detailed field descriptions, see `PERFORMANCE_METRICS.md`.

Happy backtesting! 🚀

