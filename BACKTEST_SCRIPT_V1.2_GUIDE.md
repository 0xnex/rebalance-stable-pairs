# Backtest Script V1.2 Option A Configuration Guide

## Overview
The `backtest_option_2.4.1.1.sh` script is configured to run backtests using the V1.2 Option A strategy with contiguous bands and equal distribution.

## Key V1.2 Option A Configuration

### 1. Rebalancing Constraints
```bash
export THREEBAND_MAX_DAILY_REBALANCES=1          # Maximum 1 rebalance per day
export THREEBAND_MIN_REBALANCE_COOLDOWN_MS=600000 # 10 minutes cooldown (600,000 ms)
```

**Why these values?**
- V1.2 Option A limits aggressive rebalancing to reduce transaction costs
- 10-minute cooldown prevents rapid successive rebalances
- 1 daily rebalance maximum ensures strategic position management

### 2. Position Allocation (Equal Distribution)
```bash
export THREEBAND_POS1_ALLOCATION=33.33  # Position 1: 33.33%
export THREEBAND_POS2_ALLOCATION=33.33  # Position 2: 33.33%
export THREEBAND_POS3_ALLOCATION=33.34  # Position 3: 33.34%
```

**Why equal allocation?**
- V1.2 Option A distributes capital evenly across all three positions
- Avoids over-concentration in narrow ranges
- Provides balanced exposure to different price ranges
- 33.34% for Position 3 accounts for rounding (total = 100%)

### 3. Range Multipliers (Contiguous Bands)
```bash
export THREEBAND_BASE_RANGE_MULTIPLIER=1.0    # Position 1: Base × 1.0
export THREEBAND_MEDIUM_RANGE_MULTIPLIER=1.5  # Position 2: Base × 1.5
export THREEBAND_WIDE_RANGE_MULTIPLIER=2.0    # Position 3: Base × 2.0
```

**How it works:**
- Base range is defined by `THREEBAND_RANGE_PERCENT=0.0001` (0.01%)
- Position 1 (narrowest): 0.01% × 1.0 = 0.01% range
- Position 2 (medium): 0.01% × 1.5 = 0.015% range
- Position 3 (widest): 0.01% × 2.0 = 0.02% range
- Positions are placed **contiguously** (no overlap, no gaps)

### 4. Market Indicators for Entry Conditions
```bash
export THREEBAND_TREND_SCORE=50   # Minimum trend score for entry
export THREEBAND_SAFETY_SCORE=50  # Minimum safety score for entry
```

**Entry validation:**
- Strategy will only open positions when both scores ≥ 50
- Trend Score: Market momentum indicator (0-100)
- Safety Score: Risk assessment indicator (0-100)
- Both must be satisfied before deploying capital

### 5. Monitoring Interval
```bash
export THREEBAND_FAST_INTERVAL_MS=600000  # 10 minutes (600,000 ms)
```

**Why 10 minutes?**
- Aligns with V1.2 Option A's less aggressive strategy
- Reduces computational overhead
- Matches the rebalancing cooldown period
- Provides sufficient time to observe price movements

## Differences from Previous Versions

| Parameter | Old Value (Option 3) | New Value (V1.2 Option A) | Change Reason |
|-----------|---------------------|---------------------------|---------------|
| `MAX_DAILY_REBALANCES` | 5 | 1 | Reduce transaction costs |
| `MIN_REBALANCE_COOLDOWN_MS` | 3,600,000 (1 hour) | 600,000 (10 min) | More responsive while controlled |
| `POS1_ALLOCATION` | 60% | 33.33% | Equal distribution |
| `POS2_ALLOCATION` | 20% | 33.33% | Equal distribution |
| `POS3_ALLOCATION` | 20% | 33.34% | Equal distribution |
| Position Definition | `POS1/2/3_TICK_WIDTH` | `BASE/MEDIUM/WIDE_RANGE_MULTIPLIER` | Flexible range sizing |
| `FAST_INTERVAL_MS` | 10,000 (10 sec) | 600,000 (10 min) | Align with strategy cadence |
| New: `TREND_SCORE` | N/A | 50 | Entry condition validation |
| New: `SAFETY_SCORE` | N/A | 50 | Entry condition validation |

## Strategy File Reference
```bash
--strategy ./src/strategies/three_band_rebalancer_backtest_2.4.1.1.ts
```

This points to the V1.2 Option A backtest wrapper, which internally uses:
- `three_band_rebalancer_strategy_option_2.4.1.1.ts` (the main strategy implementation)

## Running the Backtest

### Basic Usage
```bash
chmod +x backtest_option_2.4.1.1.sh
./backtest_option_2.4.1.1.sh
```

### Customizing Parameters
You can override any environment variable before running:
```bash
# Test with higher trend score requirement
export THREEBAND_TREND_SCORE=60
export THREEBAND_SAFETY_SCORE=60
./backtest_option_2.4.1.1.sh

# Test with different base range
export THREEBAND_RANGE_PERCENT=0.0002  # 0.02% base range
./backtest_option_2.4.1.1.sh

# Test with different time period
# Edit the script's --start and --end parameters directly
```

### Adjusting Date Range
Edit these lines in the script:
```bash
--start "2025-08-20T00:00:00Z" \
--end "2025-09-01T00:00:00Z" \
```

## Output Files

### CSV Output
The backtest will generate a CSV file with this naming pattern:
```
three_band_v1.2_optionA_backtest_suiUSDT_USDC_0_10000000000_<timestamp>.csv
```

### CSV Columns Include:
- Timestamp
- Current tick and price
- Action (monitor/rebalance)
- In-range position count
- Rebalance flag
- Daily rebalance count
- Position data (3 positions):
  - Tick ranges
  - Token amounts (raw and decimal)
  - Total values
  - Allocation percentages

## Expected Behavior (V1.2 Option A)

### Initial Setup
1. Check if Safety Score ≥ 50 and Trend Score ≥ 50
2. If conditions met, open 3 contiguous positions with equal allocation
3. If conditions not met, wait until they are satisfied

### Monitoring Phase
- Check positions every 10 minutes
- Track fee accumulation on each position
- Monitor price distance from position ranges

### Rebalancing Decision
When price moves out of range:
1. Identify the **farthest** out-of-range position
2. Calculate profitability:
   - If Trend Score ≥ 60: `Fee - Price Loss - Swap Fee > 0`
   - If Trend Score < 60: `Fee - Swap Fee > 0` (ignore price loss)
3. Check constraints:
   - Daily rebalances < 1
   - Time since last rebalance ≥ 10 minutes
4. If all conditions met, rebalance only that one position

### Key Differences from Option 3
- **Fewer rebalances**: 1/day instead of 5/day
- **Equal allocation**: 33.33% each instead of 60/20/20
- **Contiguous ranges**: No overlap between positions
- **Selective rebalancing**: Only farthest position, not all positions
- **Trend-aware decisions**: Different profitability thresholds based on trend

## Troubleshooting

### No positions opened
- Check that `THREEBAND_TREND_SCORE` and `THREEBAND_SAFETY_SCORE` are set appropriately
- Verify the scores in your data meet the minimum thresholds (≥50)
- Consider lowering the score requirements for testing

### Too few rebalances
- This is expected with `MAX_DAILY_REBALANCES=1`
- V1.2 Option A is designed to be conservative
- Check that cooldown period has elapsed (10 minutes)

### Positions not contiguous
- Verify range multipliers are set correctly (1.0, 1.5, 2.0)
- Check that `THREEBAND_RANGE_PERCENT` is reasonable for the pool
- Review the strategy's `openSegment()` logic

### Allocation percentages incorrect
- Confirm exports: 33.33, 33.33, 33.34
- Check CSV output to verify actual allocations
- Ensure total adds up to 100%

## Performance Metrics to Evaluate

When analyzing results, focus on:
1. **Fee earnings** vs **price loss** (impermanent loss)
2. **Number of rebalances** (should be ≤1 per day)
3. **Position utilization** (time each position is in-range)
4. **Capital efficiency** (returns per unit of capital deployed)
5. **Transaction costs** (rebalancing frequency × costs)
6. **Sharpe ratio** (risk-adjusted returns)

## Further Customization

### Testing Different Volatility Regimes
Adjust base range for different market conditions:
```bash
# Very stable market (tight ranges)
export THREEBAND_RANGE_PERCENT=0.00005  # 0.005%

# Normal stable market (default)
export THREEBAND_RANGE_PERCENT=0.0001  # 0.01%

# Volatile stable market (wider ranges)
export THREEBAND_RANGE_PERCENT=0.0003  # 0.03%
```

### Testing Different Entry Thresholds
```bash
# Conservative entry (wait for better conditions)
export THREEBAND_TREND_SCORE=70
export THREEBAND_SAFETY_SCORE=70

# Aggressive entry (enter more often)
export THREEBAND_TREND_SCORE=30
export THREEBAND_SAFETY_SCORE=30
```

### Testing Different Allocation Strategies
While V1.2 Option A specifies equal allocation, you can test variations:
```bash
# Front-loaded allocation (more in narrow range)
export THREEBAND_POS1_ALLOCATION=50
export THREEBAND_POS2_ALLOCATION=30
export THREEBAND_POS3_ALLOCATION=20

# Back-loaded allocation (more in wide range)
export THREEBAND_POS1_ALLOCATION=20
export THREEBAND_POS2_ALLOCATION=30
export THREEBAND_POS3_ALLOCATION=50
```

## Conclusion
This script is fully configured for V1.2 Option A backtesting with:
- ✅ Contiguous bands (no overlap)
- ✅ Equal allocation (33.33% each)
- ✅ Conservative rebalancing (1/day, 10-min cooldown)
- ✅ Entry condition validation (Safety & Trend Scores)
- ✅ Trend-aware profitability calculations
- ✅ Range multipliers (1.0, 1.5, 2.0)

Run the script and analyze the CSV output to evaluate strategy performance!
