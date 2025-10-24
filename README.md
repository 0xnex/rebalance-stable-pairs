# Rebalance Stable Pairs - Backtest Framework

A high-performance backtest framework for testing concentrated liquidity market making strategies on stablecoin pairs.

## 🚀 Quick Start

### Installation
```bash
bun install
```

### Run a Backtest
```bash
bun run src/backtest.ts \
  --strategy three-band \
  --poolId 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 \
  --start "2025-08-20T00:00:00Z" \
  --end "2025-08-21T00:00:00Z" \
  --token0 USDC \
  --token1 USDT
```

## 📚 Documentation

- **[GUIDE.md](GUIDE.md)** - Complete framework guide
  - Architecture overview
  - Strategy development
  - Performance analysis
  - Advanced usage

- **[PERFORMANCE_METRICS.md](PERFORMANCE_METRICS.md)** - CSV output field descriptions
  - Fund-level metrics
  - Position-level metrics

- **[THREE_BAND_STRATEGY_GUIDE.md](THREE_BAND_STRATEGY_GUIDE.md)** - Three-Band pyramid strategy
  - Strategy design
  - Performance results
  - Configuration options

## 🎯 Key Features

✅ **Event-Driven Architecture** - Real historical data replay  
✅ **Wallet Management** - Automatic balance tracking  
✅ **Multiple Strategies** - Easy strategy development and comparison  
✅ **Performance Tracking** - Comprehensive PnL, ROI, fee analysis  
✅ **CSV Export** - Structured data for analysis  
✅ **CLI Interface** - Simple command-line operation  

## 🔧 Available Strategies

| Strategy | Description |
|----------|-------------|
| `noop` | No operations (baseline) |
| `example` | Simple rebalancing example |
| `three-band` | Pyramid strategy with 3 bands |

## 📊 Output

Backtests generate two CSV files:
- `fund_performance_*.csv` - Overall fund metrics
- `position_performance_*.csv` - Per-position metrics

## 🛠️ Development

### Create a New Strategy

1. **Create strategy file:**
```typescript
// src/strategies/my_strategy.ts
import type { IStrategy, BacktestContext } from "../types";

export class MyStrategy implements IStrategy {
  onStart(context: BacktestContext): void { /* Setup */ }
  onTick(timestamp: number, context: BacktestContext): void { /* Logic */ }
  onEnd(context: BacktestContext): void { /* Cleanup */ }
}
```

2. **Register in backtest.ts:**
```typescript
import { MyStrategy } from "./strategies/my_strategy";

function createStrategy(strategyName: string): IStrategy {
  switch (strategyName.toLowerCase()) {
    case "my-strategy":
      return new MyStrategy();
    // ...
  }
}
```

3. **Run:**
```bash
bun run src/backtest.ts --strategy my-strategy ...
```

See [GUIDE.md](GUIDE.md) for complete development instructions.

## 🧪 Testing

```bash
# Run all tests
bun test

# Run specific test
bun test tests/performance_tracking.test.ts
```

## 📈 Compare Strategies

```bash
# Use comparison script
./scripts/compare_strategies.sh <poolId> <start> <end>

# Or manually
bun run src/backtest.ts --strategy noop ... --output ./results-noop
bun run src/backtest.ts --strategy three-band ... --output ./results-three-band
```

## 🏗️ Architecture

```
Backtest Engine
  ├── Event Importer (historical data)
  ├── Pool Simulator (price & liquidity)
  ├── Position Manager (wallet & positions)
  └── Strategy (your trading logic)
       ├── onStart()
       ├── onTick() (called every second)
       └── onEnd()
```

## 🔗 Links

- Framework Guide: [GUIDE.md](GUIDE.md)
- Performance Metrics: [PERFORMANCE_METRICS.md](PERFORMANCE_METRICS.md)
- Three-Band Strategy: [THREE_BAND_STRATEGY_GUIDE.md](THREE_BAND_STRATEGY_GUIDE.md)

## 📝 License

This project was created using [Bun](https://bun.com) runtime.
