# Backtest Framework Guide

A comprehensive guide to the liquidity pool backtesting framework for concentrated liquidity strategies.

## Table of Contents

- [Overview](#overview)
- [Framework Features](#framework-features)
- [What's Included](#whats-included)
- [What's NOT Included](#whats-not-included)
- [Core Components](#core-components)
- [Writing Your Strategy](#writing-your-strategy)
- [Position Management](#position-management)
- [Fee Collection](#fee-collection)
- [Querying Data](#querying-data)
- [Complete Example](#complete-example)
- [Performance Tracking](#performance-tracking)
- [Best Practices](#best-practices)

---

## Overview

This framework allows you to backtest concentrated liquidity market-making strategies using historical swap events from blockchain data. It simulates a virtual wallet with positions, fee collection, and portfolio tracking.

### Key Capabilities

- ✅ Replay historical swap events with accurate timestamps
- ✅ Create/close concentrated liquidity positions dynamically
- ✅ Automatic fee distribution based on active liquidity
- ✅ Real-time position and portfolio value tracking
- ✅ Performance metrics (returns, drawdown, Sharpe ratio)
- ✅ CSV export of vault and position snapshots
- ✅ Time-based and event-based strategy hooks

---

## Framework Features

### 1. **Event Replay Engine**

- Loads swap events from JSON files or database
- Automatically sorts events chronologically
- Time-stepped simulation with configurable intervals
- Pool state updates (price, tick, liquidity, reserves)

### 2. **Virtual Position Manager**

- Create positions with tick ranges and amounts
- Automatic liquidity calculation
- Fee distribution based on active liquidity share
- Position closure with automatic fee collection
- Track multiple positions simultaneously

### 3. **Performance Analytics**

- Initial and final portfolio value
- Absolute and percentage returns
- Maximum drawdown tracking
- Historical value samples for charting
- Per-position profitability

### 4. **Snapshot System**

- Vault state snapshots (cash, positions, fees)
- Position-level snapshots (liquidity, range, value)
- CSV streaming for large backtests
- Configurable snapshot intervals

### 5. **Strategy Hooks**

- `onInit()`: Initialize strategy at start
- `onTick()`: Execute logic at each time step
- `onSwapEvent()`: React to individual swaps
- `onFinish()`: Clean up at backtest end

---

## What's Included

### ✅ Included Features

1. **Position Management**

   - Create positions with custom tick ranges
   - Close positions (removes liquidity + collects fees)
   - Query position state (liquidity, amounts, fees owed)
   - Check if position is in range

2. **Fee Mechanics**

   - Automatic fee accrual based on active liquidity
   - Proportional fee distribution to positions
   - Fee collection (moves fees to cash balance)
   - Separate tracking of collected vs. owed fees

3. **Pool State**

   - Current price and tick
   - Active liquidity at current tick
   - Token reserves

4. **Portfolio Tracking**

   - Cash balances (token0, token1)
   - Position values at current prices
   - Uncollected and collected fees
   - Total portfolio value in quote token

5. **Logging and Debugging**
   - Pool state updates
   - Fee distribution details
   - Position creation/closure events
   - Strategy-specific logging

---

## What's NOT Included

### ❌ Not Included

1. **Slippage Simulation**

   - Framework uses historical swap outcomes directly
   - Your positions don't impact pool price
   - No simulation of price impact from your trades

2. **Gas Costs**

   - Transaction costs are not deducted
   - Rebalancing is "free" in the simulation
   - Real costs would reduce returns

3. **Liquidity Constraints**

   - Unlimited capital assumption
   - Can always create positions at desired ranges
   - No simulation of position NFTs or pool capacity

---

## Core Components

### BacktestEngine

The main orchestrator that:

- Loads and replays swap events
- Manages the global simulation clock
- Calls strategy hooks at appropriate times
- Tracks performance metrics

```typescript
const engine = new BacktestEngine({
  poolId: "0x737ec...",
  startTime: new Date("2025-08-20").getTime(),
  endTime: new Date("2025-08-21").getTime(),
  decimals0: 8,
  decimals1: 8,
  feeRatePpm: 100, // 0.01% = 100 ppm
  tickSpacing: 2,
  stepMs: 1000, // 1 second per step
  dataDir: "./data",
  invest0: 5000_00000000n, // Initial token0
  invest1: 5000_00000000n, // Initial token1
  strategyFactory: (pool, manager) => new MyStrategy(pool, manager),
  logger: console,
  metricsIntervalMs: 60_000, // Sample every minute
});

const report = await engine.run();
```

### Pool

Represents the liquidity pool state:

```typescript
interface Pool {
  price: number; // Current price (token1/token0)
  tickCurrent: number; // Current tick index
  liquidity: bigint; // Active liquidity at current tick
  sqrtPriceX64: bigint; // Square root price in Q64.64 format
  reserve0: bigint; // Token0 reserves
  reserve1: bigint; // Token1 reserves
  feeRatePpm: bigint; // Fee rate in parts per million
  tickSpacing: number; // Minimum tick spacing
}
```

### VirtualPositionManager

Manages all positions and wallet state:

```typescript
interface VirtualPositionManager {
  // Wallet state
  amount0: bigint; // Current token0 balance
  amount1: bigint; // Current token1 balance

  // Position operations
  createPosition(
    id: string,
    tickLower: number,
    tickUpper: number,
    amount0: bigint,
    amount1: bigint,
    createdAt: number
  ): VirtualPosition;

  closePosition(id: string): {
    amount0: bigint;
    amount1: bigint;
    fee0: bigint;
    fee1: bigint;
  };

  getPosition(id: string): VirtualPosition | undefined;

  // Fee operations
  collectAllPositionFees(): { fee0: bigint; fee1: bigint };
  updateAllPositionFees(event: SwapEvent): void;

  // Portfolio query
  getTotals(): {
    amountA: bigint; // Total token0 (cash + positions)
    amountB: bigint; // Total token1 (cash + positions)
    feesOwed0: bigint; // Uncollected fees token0
    feesOwed1: bigint; // Uncollected fees token1
    positions: number; // Active position count
    collectedFees0: bigint; // Historical collected fees
    collectedFees1: bigint; // Historical collected fees
    initialAmountA: bigint; // Starting capital token0
    initialAmountB: bigint; // Starting capital token1
    cashAmountA: bigint; // Available cash token0
    cashAmountB: bigint; // Available cash token1
  };
}
```

### VirtualPosition

Represents a single liquidity position:

```typescript
interface VirtualPosition {
  id: string;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  createdAt: number;

  // Query methods
  isInRange(currentTick: number): boolean;

  getTotals(sqrtPriceX64: bigint): {
    amount0: bigint; // Token0 in position
    amount1: bigint; // Token1 in position
    fee0: bigint; // Fees owed token0
    fee1: bigint; // Fees owed token1
  };

  collectFees(): { fee0: bigint; fee1: bigint };
}
```

---

## Writing Your Strategy

### Strategy Interface

Every strategy must implement the `BacktestStrategy` interface:

```typescript
export interface BacktestStrategy {
  readonly id: string;

  // Required: Initialize strategy (called once at start)
  onInit(ctx: StrategyContext): Promise<void> | void;

  // Required: Called at each time step
  onTick(ctx: StrategyContext): Promise<void> | void;

  // Optional: React to individual swap events
  onSwapEvent?(ctx: StrategyContext, event: SwapEvent): Promise<void> | void;

  // Optional: Clean up at end
  onFinish?(ctx: StrategyContext): Promise<void> | void;
}
```

### Strategy Context

Every hook receives a `StrategyContext` with access to:

```typescript
interface StrategyContext {
  timestamp: number; // Current simulation time (ms)
  stepIndex: number; // Current step number
  pool: Pool; // Pool state (read-only reference)
  manager: VirtualPositionManager; // Position manager
  logger?: Console; // Optional logger
}
```

### Minimal Strategy Example

```typescript
import type { BacktestStrategy, StrategyContext } from "../backtest_engine";

export class MinimalStrategy implements BacktestStrategy {
  readonly id = "minimal-strategy";

  onInit(ctx: StrategyContext): void {
    console.log(`Starting at price ${ctx.pool.price.toFixed(6)}`);
  }

  onTick(ctx: StrategyContext): void {
    // Execute logic every time step
    if (ctx.stepIndex % 1000 === 0) {
      console.log(`Step ${ctx.stepIndex}: price=${ctx.pool.price.toFixed(6)}`);
    }
  }
}

// Factory function for BacktestEngine
export const strategyFactory = (pool, manager) => new MinimalStrategy();
```

---

## Position Management

### Creating a Position

```typescript
onInit(ctx: StrategyContext): void {
  // Define position range (e.g., ±0.1% around current price)
  const currentTick = ctx.pool.tickCurrent;
  const tickLower = currentTick - 10;
  const tickUpper = currentTick + 10;

  // Allocate capital (50/50 split)
  const amount0 = 2500_00000000n; // 2500 tokens with 8 decimals
  const amount1 = 2500_00000000n;

  // Create position
  const position = ctx.manager.createPosition(
    "position-1",        // Unique ID
    tickLower,           // Lower tick
    tickUpper,           // Upper tick
    amount0,             // Max token0 to deposit
    amount1,             // Max token1 to deposit
    ctx.timestamp        // Creation time
  );

  console.log(`Created position with liquidity: ${position.liquidity}`);
}
```

**Important Notes:**

- `amount0` and `amount1` are **maximum amounts** to deposit
- Actual amounts used depend on current price and range
- Unused amounts remain in cash balance
- Position must span valid tick range (aligned to `tickSpacing`)

### Querying Position State

```typescript
onTick(ctx: StrategyContext): void {
  const position = ctx.manager.getPosition("position-1");

  if (position) {
    // Check if price is in range
    const inRange = position.isInRange(ctx.pool.tickCurrent);

    // Get current amounts and fees
    const totals = position.getTotals(ctx.pool.sqrtPriceX64);
    console.log(`Position: ${totals.amount0} / ${totals.amount1}`);
    console.log(`Fees owed: ${totals.fee0} / ${totals.fee1}`);
    console.log(`In range: ${inRange}`);
  }
}
```

### Checking Position Range

```typescript
onTick(ctx: StrategyContext): void {
  const position = ctx.manager.getPosition("position-1");

  if (position) {
    const currentTick = ctx.pool.tickCurrent;

    if (currentTick < position.tickLower) {
      console.log("Position is below range (all token0)");
    } else if (currentTick > position.tickUpper) {
      console.log("Position is above range (all token1)");
    } else {
      console.log("Position is active (earning fees)");
    }
  }
}
```

### Closing a Position

```typescript
onTick(ctx: StrategyContext): void {
  // Decide to close (e.g., position out of range)
  const position = ctx.manager.getPosition("position-1");

  if (position && !position.isInRange(ctx.pool.tickCurrent)) {
    // Close position (removes liquidity + collects fees)
    const result = ctx.manager.closePosition("position-1");

    console.log(`Closed position:`);
    console.log(`  Returned: ${result.amount0} / ${result.amount1}`);
    console.log(`  Fees: ${result.fee0} / ${result.fee1}`);

    // Tokens are now in cash balance
    console.log(`New cash: ${ctx.manager.amount0} / ${ctx.manager.amount1}`);
  }
}
```

---

## Fee Collection

### Automatic Fee Accrual

Fees are automatically accrued to positions as swaps occur:

```typescript
// NO ACTION NEEDED - fees accrue automatically!
// The framework calls manager.updateAllPositionFees() after each swap
```

### Collecting Fees Without Closing

```typescript
onTick(ctx: StrategyContext): void {
  // Collect fees from all positions (without closing them)
  const fees = ctx.manager.collectAllPositionFees();

  console.log(`Collected fees: ${fees.fee0} / ${fees.fee1}`);

  // Fees are now in cash balance
  // Positions remain open and continue earning
}
```

### Fee Distribution Logic

Fees are distributed proportionally based on **active liquidity**:

```typescript
// For a swap through tick range [tickBefore, tickAfter]:
// 1. Find all positions that overlap this range
// 2. Calculate total active liquidity (pool + our positions)
// 3. Distribute fee proportionally:

const ourShare = ourLiquidity / (poolLiquidity + ourLiquidity);
const ourFee = totalSwapFee * ourShare;
```

**Example:**

- Swap fee: 1000 units
- Pool liquidity: 1,000,000
- Your position liquidity: 1,000
- Your share: 1,000 / 1,001,000 ≈ 0.1%
- Your fee: 1000 \* 0.001 ≈ 1 unit

---

## Querying Data

### Pool State

```typescript
onTick(ctx: StrategyContext): void {
  const pool = ctx.pool;

  console.log(`Price: ${pool.price.toFixed(6)}`);           // Human-readable price
  console.log(`Tick: ${pool.tickCurrent}`);                  // Current tick
  console.log(`Liquidity: ${pool.liquidity}`);               // Active liquidity
  console.log(`Reserves: ${pool.reserve0} / ${pool.reserve1}`);
  console.log(`SqrtPrice: ${pool.sqrtPriceX64}`);           // Q64.64 format
}
```

### Portfolio Totals

```typescript
onTick(ctx: StrategyContext): void {
  const totals = ctx.manager.getTotals();

  console.log(`=== Portfolio ===`);
  console.log(`Cash: ${totals.cashAmountA} / ${totals.cashAmountB}`);
  console.log(`Total: ${totals.amountA} / ${totals.amountB}`);
  console.log(`Fees Owed: ${totals.feesOwed0} / ${totals.feesOwed1}`);
  console.log(`Fees Collected: ${totals.collectedFees0} / ${totals.collectedFees1}`);
  console.log(`Open Positions: ${totals.positions}`);

  // Calculate total value in quote token (token1)
  const totalValue =
    Number(totals.amountA) * ctx.pool.price +
    Number(totals.amountB) +
    Number(totals.feesOwed0) * ctx.pool.price +
    Number(totals.feesOwed1);

  console.log(`Total Value: ${totalValue.toFixed(2)} (in token1)`);
}
```

### Individual Position Query

```typescript
onTick(ctx: StrategyContext): void {
  const position = ctx.manager.getPosition("my-position");

  if (position) {
    const totals = position.getTotals(ctx.pool.sqrtPriceX64);

    console.log(`Position: ${position.id}`);
    console.log(`  Range: [${position.tickLower}, ${position.tickUpper}]`);
    console.log(`  Liquidity: ${position.liquidity}`);
    console.log(`  Token0: ${totals.amount0}`);
    console.log(`  Token1: ${totals.amount1}`);
    console.log(`  Fees: ${totals.fee0} / ${totals.fee1}`);
    console.log(`  In Range: ${position.isInRange(ctx.pool.tickCurrent)}`);
  }
}
```

### Converting Prices

```typescript
import { LiquidityCalculator } from "../liquidity_calculator";

onTick(ctx: StrategyContext): void {
  // Convert sqrtPriceX64 to human-readable price
  const price = LiquidityCalculator.sqrtPriceX64ToPrice(
    ctx.pool.sqrtPriceX64
  );

  console.log(`Current price: ${price.toFixed(6)}`);
}
```

---

## Complete Example

Here's a complete strategy that rebalances when price moves out of range:

```typescript
import type {
  BacktestStrategy,
  StrategyContext,
  SwapEvent,
} from "../backtest_engine";

export class SimpleRebalanceStrategy implements BacktestStrategy {
  readonly id = "simple-rebalance";
  private positionId = "main-position";
  private rebalanceCount = 0;

  onInit(ctx: StrategyContext): void {
    console.log(`[${this.id}] Starting backtest`);
    console.log(
      `  Initial capital: ${ctx.manager.amount0} / ${ctx.manager.amount1}`
    );
    console.log(`  Starting price: ${ctx.pool.price.toFixed(6)}`);

    // Create initial position
    this.createPosition(ctx);
  }

  onTick(ctx: StrategyContext): void {
    // Check if rebalance needed (every 10 minutes)
    if (ctx.stepIndex % 600 === 0) {
      const position = ctx.manager.getPosition(this.positionId);

      if (position && !position.isInRange(ctx.pool.tickCurrent)) {
        console.log(`[${this.id}] Position out of range, rebalancing...`);
        this.rebalance(ctx);
      }
    }
  }

  onSwapEvent?(ctx: StrategyContext, event: SwapEvent): void {
    // Could implement swap-based logic here
    // e.g., rebalance after large swaps
  }

  onFinish(ctx: StrategyContext): void {
    console.log(`[${this.id}] Backtest complete`);
    console.log(`  Rebalances: ${this.rebalanceCount}`);

    // Close final position
    const position = ctx.manager.getPosition(this.positionId);
    if (position && position.liquidity > 0n) {
      const result = ctx.manager.closePosition(this.positionId);
      console.log(`  Final fees: ${result.fee0} / ${result.fee1}`);
    }

    // Show final totals
    const totals = ctx.manager.getTotals();
    console.log(`  Final cash: ${totals.cashAmountA} / ${totals.cashAmountB}`);
    console.log(
      `  Total fees: ${totals.collectedFees0} / ${totals.collectedFees1}`
    );
  }

  private createPosition(ctx: StrategyContext): void {
    // Create ±0.2% range around current price
    const currentTick = ctx.pool.tickCurrent;
    const tickRange = 20; // 20 ticks ≈ 0.2% for tick spacing = 2

    const tickLower = currentTick - tickRange;
    const tickUpper = currentTick + tickRange;

    // Use all available capital
    const amount0 = ctx.manager.amount0;
    const amount1 = ctx.manager.amount1;

    const position = ctx.manager.createPosition(
      this.positionId,
      tickLower,
      tickUpper,
      amount0,
      amount1,
      ctx.timestamp
    );

    console.log(
      `[${this.id}] Created position: liquidity=${position.liquidity}`
    );
  }

  private rebalance(ctx: StrategyContext): void {
    // Close old position
    const oldPosition = ctx.manager.getPosition(this.positionId);
    if (oldPosition && oldPosition.liquidity > 0n) {
      ctx.manager.closePosition(this.positionId);
    }

    // Create new position around current price
    this.createPosition(ctx);
    this.rebalanceCount++;
  }
}

export const strategyFactory = (pool, manager) => new SimpleRebalanceStrategy();
```

---

## Performance Tracking

The framework automatically tracks performance metrics:

```typescript
const report = await engine.run();

console.log("=== Performance ===");
console.log(`Initial Value: $${report.performance.initialValue.toFixed(2)}`);
console.log(`Final Value: $${report.performance.finalValue.toFixed(2)}`);
console.log(`Return: ${report.performance.returnPct.toFixed(2)}%`);
console.log(`Max Drawdown: ${report.performance.maxDrawdownPct.toFixed(2)}%`);
console.log(`Highest Value: $${report.performance.highestValue.toFixed(2)}`);
console.log(`Lowest Value: $${report.performance.lowestValue.toFixed(2)}`);

// Access historical samples for charting
for (const sample of report.performance.samples) {
  console.log(`${new Date(sample.timestamp).toISOString()}: $${sample.value}`);
}
```

---

## Best Practices

### 1. **Always Close Positions in `onFinish()`**

```typescript
onFinish(ctx: StrategyContext): void {
  // Close all open positions to realize final P&L
  for (const [id, position] of ctx.manager.positions) {
    if (position.liquidity > 0n) {
      ctx.manager.closePosition(id);
    }
  }

  // Collect any remaining fees
  ctx.manager.collectAllPositionFees();
}
```

### 2. **Handle Insufficient Capital**

```typescript
onInit(ctx: StrategyContext): void {
  try {
    const position = ctx.manager.createPosition(...);
  } catch (error) {
    console.error("Failed to create position:", error);
    // Handle gracefully (e.g., adjust range or amounts)
  }
}
```

### 3. **Use Unique Position IDs**

```typescript
// Good: Unique IDs
const position1 = ctx.manager.createPosition("btc-range-1", ...);
const position2 = ctx.manager.createPosition("btc-range-2", ...);

// Bad: Reusing ID will throw error
const position3 = ctx.manager.createPosition("btc-range-1", ...); // ERROR!
```

### 4. **Check Position Exists Before Operations**

```typescript
onTick(ctx: StrategyContext): void {
  const position = ctx.manager.getPosition("my-position");

  if (position) {
    // Safe to use position
    if (!position.isInRange(ctx.pool.tickCurrent)) {
      ctx.manager.closePosition("my-position");
    }
  }
}
```

### 5. **Respect Tick Spacing**

```typescript
// For tickSpacing = 2, ticks must be even
const tickLower = Math.floor(currentTick / 2) * 2 - 20; // Aligned
const tickUpper = Math.floor(currentTick / 2) * 2 + 20; // Aligned
```

### 6. **Log Important Events**

```typescript
onTick(ctx: StrategyContext): void {
  // Log periodically, not every tick
  if (ctx.stepIndex % 1000 === 0) {
    const totals = ctx.manager.getTotals();
    ctx.logger?.log?.(
      `[${this.id}] Step ${ctx.stepIndex}: ` +
      `value=${this.calculateValue(ctx, totals)}`
    );
  }
}
```

### 7. **Use BigInt for All Token Amounts**

```typescript
// Correct: Use BigInt with proper decimals
const amount0 = 5000_00000000n; // 5000 tokens with 8 decimals

// Wrong: Don't use numbers for token amounts
const amount0 = 5000; // Will be treated as 0.00005000 tokens!
```

### 8. **Test with Small Time Ranges First**

```bash
# Start with 1 day to validate logic
startTime: new Date("2025-08-20").getTime(),
endTime: new Date("2025-08-21").getTime(),

# Then expand to weeks/months
endTime: new Date("2025-09-20").getTime(),
```

---

## Running Your Backtest

### 1. Create Strategy File

Save your strategy to `src/strategies/my_strategy.ts`:

```typescript
export class MyStrategy implements BacktestStrategy {
  // ... implementation ...
}

export const strategyFactory = (pool, manager) => new MyStrategy();
```

### 2. Create Runner Script

Save to `scripts/run_my_strategy.ts`:

```typescript
import { BacktestEngine } from "../src/backtest_engine";
import { strategyFactory } from "../src/strategies/my_strategy";

async function main() {
  const engine = new BacktestEngine({
    poolId: "0x737ec...",
    startTime: new Date("2025-08-20").getTime(),
    endTime: new Date("2025-08-21").getTime(),
    decimals0: 8,
    decimals1: 8,
    feeRatePpm: 100,
    tickSpacing: 2,
    stepMs: 1000,
    dataDir: "../mmt_txs/0x737ec...",
    invest0: 5000_00000000n,
    invest1: 5000_00000000n,
    strategyFactory,
    logger: console,
    metricsIntervalMs: 60_000,
  });

  const report = await engine.run();
  console.log("Return:", report.performance.returnPct.toFixed(2) + "%");
}

main().catch(console.error);
```

### 3. Run the Backtest

```bash
bun run scripts/run_my_strategy.ts
```

---

## FAQ

### Q: Why is my position liquidity zero?

**A:** If you provide only one token (e.g., only token1) but the position range requires both tokens at current price, the position will have zero liquidity. Always provide both tokens or adjust your range.

### Q: Why aren't my fees increasing?

**A:** Fees only accrue when:

1. The position is **in range** (current tick between tickLower and tickUpper)
2. Swaps are occurring through that tick range
3. Your position has non-zero liquidity

### Q: Can I short or use leverage?

**A:** No, the framework only simulates **long-only liquidity provision**. You cannot borrow tokens or use leverage.

### Q: How accurate are the results?

**A:** Very accurate for **fee collection** and **IL calculations**, but missing:

- Gas costs (would reduce returns by ~0.1-1% for frequent rebalancing)
- Slippage (assumes your trades don't impact price)
- MEV (assumes no front-running or sandwiching)

### Q: Can I backtest multiple strategies?

**A:** Yes! Run multiple backtests with different strategy factories and compare results.

---

## Summary

This framework provides a powerful toolkit for backtesting concentrated liquidity strategies:

✅ **Core Features**: Position management, fee tracking, performance analytics  
✅ **Accurate Simulation**: Historical swap replay with precise fee distribution  
✅ **Flexible Hooks**: React to ticks, swaps, and time events  
✅ **Production Ready**: Includes logging, snapshots, and error handling

❌ **Limitations**: No slippage, gas costs, MEV, or multi-pool support

**Start simple** with a hold strategy, then iterate towards more complex rebalancing logic. Happy backtesting! 🚀
