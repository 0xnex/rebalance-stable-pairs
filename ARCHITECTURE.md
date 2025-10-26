# Backtest Architecture

## Overview

The backtest system is designed as an **event-driven architecture** with clean separation of concerns. The core principle is that `backtest.ts` acts as an event emitter, while specialized components handle specific responsibilities.

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         backtest.ts                             │
│                     (Event Coordinator)                         │
│                                                                 │
│  Responsibilities:                                              │
│  • Load and stream swap events                                  │
│  • Generate time tick events (1 second intervals)               │
│  • Initialize core components                                   │
│  • Coordinate event flow                                        │
│                                                                 │
│  Event Types:                                                   │
│  1. Swap Events → pool, manager, (indirectly) strategy         │
│  2. Time Ticks  → strategy, performance tracker                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              │ emits events to
                              ▼
        ┌─────────────────────┴─────────────────────┐
        │                     │                     │
        ▼                     ▼                     ▼
┌──────────────┐      ┌──────────────┐      ┌──────────────────┐
│ SimplePool   │      │ Position     │      │ Performance      │
│              │      │ Manager      │      │ Tracker          │
│ Manages:     │      │              │      │                  │
│ • Price      │      │ Manages:     │      │ Captures:        │
│ • Liquidity  │      │ • Positions  │      │ • 1-min snaps    │
│ • Reserves   │      │ • Balances   │      │ • Fund metrics   │
│ • Swaps      │      │ • Fees       │      │ • Pos metrics    │
└──────────────┘      └──────────────┘      │ • CSV export     │
                              │              └──────────────────┘
                              │
                              ▼
                      ┌──────────────┐
                      │  Strategy    │
                      │  (IStrategy) │
                      │              │
                      │ • onStart()  │
                      │ • onTick()   │
                      │ • onEnd()    │
                      └──────────────┘
```

## Component Responsibilities

### 1. `backtest.ts` - Event Coordinator
**Purpose**: Orchestrate the backtest by emitting events to components

**Responsibilities**:
- Initialize core components (pool, manager, performance tracker)
- Load swap events from data files
- Generate time tick events (1 second intervals)
- Emit events in correct order:
  1. Swap event → pool (update state)
  2. Swap event → manager (distribute fees)
  3. Time tick → strategy (make decisions)
  4. Time tick → performance tracker (capture metrics)
- Print summary results

**Does NOT**:
- Calculate performance metrics (delegated to PerformanceTracker)
- Manage positions (delegated to PositionManager)
- Make trading decisions (delegated to Strategy)

### 2. `simple_pool.ts` - Pool State Manager
**Purpose**: Simulate concentrated liquidity pool behavior

**Responsibilities**:
- Track pool state (price, tick, liquidity, reserves)
- Process swap events
- Estimate pool liquidity from swap impact
- Calculate liquidity for positions
- Handle position liquidity addition/removal
- Optimize token ratios for max liquidity

**Event Handlers**:
- `onSwapEvent(evt: SwapEvent)`: Update pool state

### 3. `position_mgr.ts` - Position & Fund Manager
**Purpose**: Manage all positions and fund balances

**Responsibilities**:
- Track available balances (balance0, balance1)
- Open/close positions
- Add/remove liquidity to positions
- Distribute fees from swaps to in-range positions
- Track position in-range time
- Claim fees from positions

**Event Handlers**:
- `onSwapEvent(evt: SwapEvent)`: Distribute fees to in-range positions

**Key Methods**:
- `openPosition()`, `closePosition()`
- `addLiquidity()`, `removeLiquidity()`
- `fee()`, `claimFee()`
- `getBalance0()`, `getBalance1()`

### 4. `performance_tracker.ts` - Performance Metrics Tracker
**Purpose**: Capture and export performance metrics

**Responsibilities**:
- Capture fund performance every 1 minute
- Capture position-level performance every 1 minute
- Export metrics to CSV files
- Track snapshot count

**Event Handlers**:
- `onTimeTick(time: number)`: Capture snapshots at 1-minute intervals

**Key Methods**:
- `captureFinalSnapshot()`: Force capture at end of backtest
- `getSnapshotCount()`: Get total snapshots captured

### 5. Strategy (User-Defined)
**Purpose**: Implement trading logic

**Responsibilities**:
- Initialize strategy on start
- React to time ticks (check conditions, rebalance)
- Clean up on end

**Event Handlers**:
- `onStart(ctx: BacktestContext)`: Initialize
- `onTick(time: number, ctx: BacktestContext)`: Make decisions
- `onEnd(ctx: BacktestContext)`: Finalize

## Event Flow

### Initialization Phase
```
1. backtest.ts creates:
   - SimplePool
   - PositionManager
   - PerformanceTracker
   - SwapEventGenerator

2. First swap event received:
   - Pool.onSwapEvent() → update price/tick/liquidity
   - Strategy.onStart() → initialize strategy
```

### Main Loop (for each swap event)
```
1. Swap Event:
   Pool.onSwapEvent(event)         → Update pool state
   Manager.onSwapEvent(event)      → Distribute fees

2. Time Ticks (up to event.timestamp):
   Strategy.onTick(time, context)          → Make trading decisions
   PerformanceTracker.onTimeTick(time)     → Capture metrics (if 1-min interval)
```

### Finalization Phase
```
1. Strategy.onEnd() → Clean up
2. PerformanceTracker.captureFinalSnapshot() → Final metrics
3. backtest.ts prints summary
```

## Key Design Principles

1. **Event-Driven**: Components react to events, not polling
2. **Separation of Concerns**: Each component has one clear responsibility
3. **No Ticks Without Swaps**: Time ticks only emitted when swap events occur (price changes matter)
4. **Stateless Performance**: PerformanceTracker doesn't maintain cumulative state, calculates on-demand
5. **Clean Dependencies**: 
   - Pool: No dependencies
   - Manager: Depends on Pool
   - PerformanceTracker: Depends on Pool + Manager
   - Strategy: Uses Pool + Manager via context

## File Structure

```
src/
├── backtest.ts              # Event coordinator + CLI
├── simple_pool.ts           # Pool state manager
├── position_mgr.ts          # Position & fund manager
├── performance_tracker.ts   # Performance metrics tracker (NEW)
├── performance_exporter.ts  # Metric calculation utilities
├── fee_distribution_service.ts  # Fee calculation logic
├── types.ts                 # Type definitions
└── strategies/
    └── *.ts                 # Strategy implementations
```

## Benefits of This Architecture

1. **Modularity**: Easy to swap out components (e.g., different pool simulator)
2. **Testability**: Each component can be tested in isolation
3. **Clarity**: Clear event flow, easy to understand
4. **Extensibility**: Easy to add new event listeners (e.g., risk monitor)
5. **Performance**: No redundant calculations, components do minimal work
6. **Maintainability**: Single Responsibility Principle applied throughout

## Example: Adding a New Component

To add a risk monitor that tracks exposure:

```typescript
// src/risk_monitor.ts
export class RiskMonitor {
  constructor(pool: IPool, manager: IPositionManager) { }
  
  onTimeTick(time: number): void {
    // Calculate risk metrics
    // Log warnings if risk too high
  }
}

// In backtest.ts
const riskMonitor = new RiskMonitor(pool, manager);

// In event loop
await performanceTracker.onTimeTick(tickTime);
riskMonitor.onTimeTick(tickTime);  // Add this line
```

No changes needed to existing components!

