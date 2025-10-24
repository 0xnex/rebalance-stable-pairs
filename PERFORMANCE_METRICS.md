# Performance Metrics Documentation

## Overview

This document explains all performance metrics tracked by the system. The performance data is exported to two CSV files:
1. **`fund_performance.csv`** - Overall fund-level metrics
2. **`position_performance.csv`** - Individual position-level metrics

All monetary values are quoted in **token1** terms using the current pool price for conversion.

---

## 📊 Fund Performance Metrics

### File: `fund_performance.csv`

| Field | Type | Unit | Description |
|-------|------|------|-------------|
| `timestamp` | number | milliseconds | Unix timestamp when the snapshot was taken |
| `initial_amount0` | bigint | token0 | Initial amount of token0 deposited into the fund |
| `initial_amount1` | bigint | token1 | Initial amount of token1 deposited into the fund |
| `initial_value` | bigint | token1 | Total initial capital converted to token1 terms |
| `current_balance0` | bigint | token0 | Current balance of token0 held in the fund (not in positions) |
| `current_balance1` | bigint | token1 | Current balance of token1 held in the fund (not in positions) |
| `total_position_value` | bigint | token1 | Sum of all position values (liquidity + fees) in token1 |
| `total_fee_earned` | bigint | token1 | Total swap fees earned across all positions in token1 |
| `total_value` | bigint | token1 | Current total value = balance + position value + fees |
| `pnl` | bigint | token1 | Profit/Loss = total_value - initial_value |
| `roi_percent` | number | % | Return on Investment = (pnl / initial_value) × 100 |
| `total_slippage_cost` | bigint | token1 | Total slippage costs from rebalancing swaps in token1 |
| `total_swap_cost` | bigint | token1 | Total swap fees paid during rebalancing in token1 |
| `current_price` | number | token1/token0 | Current pool price (1 token0 = X token1) |

### Calculation Details

#### Initial Value
```
initial_value = initial_amount0 × current_price + initial_amount1
```

#### Total Position Value
```
total_position_value = Σ(position_value) for all positions
```

#### Total Value
```
total_value = (current_balance0 × current_price + current_balance1) + total_position_value
```

#### PnL
```
pnl = total_value - initial_value
```

#### ROI
```
roi_percent = (pnl / initial_value) × 100
```

---

## 📈 Position Performance Metrics

### File: `position_performance.csv`

| Field | Type | Unit | Description |
|-------|------|------|-------------|
| `timestamp` | number | milliseconds | Unix timestamp when the snapshot was taken |
| `position_id` | string | - | Unique identifier for the position |
| `lower_tick` | number | tick | Lower bound tick of the position's price range |
| `upper_tick` | number | tick | Upper bound tick of the position's price range |
| `status` | string | - | Position status: "active" or "closed" |
| `is_in_range` | boolean | - | Whether current price is within [lower_tick, upper_tick] |
| `liquidity` | bigint | L | Current liquidity (L) of the position |
| `initial_amount0` | bigint | token0 | Initial amount of token0 deposited to this position |
| `initial_amount1` | bigint | token1 | Initial amount of token1 deposited to this position |
| `initial_value` | bigint | token1 | Initial investment converted to token1 terms |
| `current_amount0` | bigint | token0 | Current amount of token0 in the position (calculated from L) |
| `current_amount1` | bigint | token1 | Current amount of token1 in the position (calculated from L) |
| `position_value` | bigint | token1 | Current position value = current_amount0 × price + current_amount1 + fees |
| `fee0` | bigint | token0 | Unclaimed swap fees in token0 |
| `fee1` | bigint | token1 | Unclaimed swap fees in token1 |
| `total_fee_earned` | bigint | token1 | Total fees earned (accumulated) in token1 |
| `pnl` | bigint | token1 | Position Profit/Loss = position_value - initial_value |
| `roi_percent` | number | % | Position ROI = (pnl / initial_value) × 100 |
| `slippage0` | bigint | token0 | Slippage loss in token0 from rebalancing swaps |
| `slippage1` | bigint | token1 | Slippage loss in token1 from rebalancing swaps |
| `slippage_cost` | bigint | token1 | Total slippage cost in token1 |
| `swap_cost0` | bigint | token0 | Swap fees paid in token0 during rebalancing |
| `swap_cost1` | bigint | token1 | Swap fees paid in token1 during rebalancing |
| `swap_cost` | bigint | token1 | Total swap fees paid in token1 |
| `current_price` | number | token1/token0 | Current pool price (1 token0 = X token1) |

### Calculation Details

#### Initial Value
```
initial_value = initial_amount0 × current_price + initial_amount1
```

#### Position Value
```
position_value = (current_amount0 × current_price + current_amount1) + (fee0 × current_price + fee1)
```

#### Total Fee Earned
```
total_fee_earned = fee0 × current_price + fee1
```

#### Slippage Cost
```
slippage_cost = slippage0 × current_price + slippage1
```

#### Swap Cost
```
swap_cost = swap_cost0 × current_price + swap_cost1
```

#### PnL
```
pnl = position_value - initial_value
```

#### ROI
```
roi_percent = (pnl / initial_value) × 100
```

---

## 🔍 Key Concepts

### Current Price
The current price is derived from the pool's `sqrtPriceX64`:
```
price = (sqrtPriceX64 / 2^64)^2
```
This represents how many token1 equals 1 token0.

### Liquidity (L)
Liquidity represents the position's share in the pool. The actual token amounts (`amount0`, `amount1`) are calculated dynamically from L based on the current price.

### In-Range vs Out-of-Range
- **In-Range**: Position earns swap fees because the current price is within [lower_tick, upper_tick]
- **Out-of-Range**: Position holds only one token type and doesn't earn fees

### Slippage vs Swap Cost
- **Slippage**: Loss due to price impact when executing swaps (difference between expected and actual output)
- **Swap Cost**: Fees paid to the pool when executing swaps (typically 0.3% or similar)

### PnL Components
```
PnL = Current Value - Initial Investment
    = Liquidity Value Change + Fees Earned - Slippage Cost - Swap Cost
```

---

## 📝 Usage Example

### Exporting Performance Data
```typescript
import { PositionManager } from "./src/position_mgr";
import { SimplePool } from "./src/simple_pool";
import { FixedSlippageProvider } from "./src/slippage_estimator";

// Create pool and manager
const pool = new SimplePool(
  "USDC",  // token0
  "USDT",  // token1
  6,       // decimals0
  6,       // decimals1
  3000,    // feeTier (0.3%)
  10,      // tickSpacing
  new FixedSlippageProvider(0.001)
);

const manager = new PositionManager(1000000n, 1000000n, pool);

// Open positions and add liquidity
manager.openPosition("pos1", -1000, 1000);
manager.addLiquidity("pos1", 500000n, 500000n);

manager.openPosition("pos2", -2000, 2000);
manager.addLiquidity("pos2", 400000n, 400000n);

// Get performance metrics
const fundPerf = manager.getFundPerformance();
console.log(`Fund PnL: ${fundPerf.pnl}`);
console.log(`Fund ROI: ${fundPerf.roiPercent}%`);

const posPerf = manager.getPositionsPerformance();
for (const pos of posPerf) {
  console.log(`Position ${pos.positionId}: PnL=${pos.pnl}, ROI=${pos.roiPercent}%`);
}

// Export to CSV
const { fundCsvPath, positionsCsvPath} = await manager.exportPerformanceToCSV('./output');

console.log(`Fund performance: ${fundCsvPath}`);
console.log(`Position performance: ${positionsCsvPath}`);
```

### Reading the CSV
```bash
# View fund performance
cat output/fund_performance_1729785600000.csv

# View position performance
cat output/position_performance_1729785600000.csv

# Or open in Excel/Google Sheets for analysis
```

### Programmatic Access
```typescript
// Get fund-level metrics
const fundPerformance = manager.getFundPerformance();

// Get position-level metrics
const positionPerformances = manager.getPositionsPerformance();

// Filter for active positions only
const activePositions = positionPerformances.filter(p => p.status === 'active');

// Find positions with negative PnL
const losingPositions = positionPerformances.filter(p => p.pnl < 0n);

// Sort by ROI
const sortedByROI = positionPerformances.sort((a, b) => b.roiPercent - a.roiPercent);
```

---

## 🎯 Interpreting the Results

### Good Performance Indicators
- ✅ **Positive PnL**: `pnl > 0`
- ✅ **High ROI**: `roi_percent > 0`
- ✅ **High Fee Revenue**: `total_fee_earned` is significant
- ✅ **Low Costs**: `slippage_cost` and `swap_cost` are minimal
- ✅ **In-Range Positions**: More positions with `is_in_range = true`

### Warning Signs
- ⚠️ **Negative PnL**: `pnl < 0` - losing money
- ⚠️ **High Slippage**: `slippage_cost` is large relative to `total_value`
- ⚠️ **Excessive Rebalancing**: `swap_cost` is high
- ⚠️ **Out-of-Range Positions**: Many positions with `is_in_range = false`

### Optimization Opportunities
1. **Reduce rebalancing frequency** if `swap_cost` is high
2. **Widen position ranges** if positions frequently go out of range
3. **Adjust position distribution** to maximize in-range liquidity
4. **Use better slippage estimation** if `slippage_cost` is significant

---

## 🔄 Version History

- **v1.0** (2025-10-24): Initial implementation with fund and position performance tracking

