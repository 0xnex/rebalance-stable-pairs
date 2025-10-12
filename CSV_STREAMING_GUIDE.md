# CSV Streaming Guide

## Overview

CSV streaming has been implemented to dramatically reduce memory usage during long backtests. Instead of buffering all snapshot data in memory and writing it at the end, data is now written to CSV files incrementally as the backtest runs.

## Benefits

✅ **Memory Efficient**: Data streams to disk instead of building up in RAM  
✅ **Real-time Progress**: Monitor backtest progress by viewing CSV files as they're written  
✅ **No Data Loss**: If backtest crashes, partial data is already saved  
✅ **Large Datasets**: Run multi-week backtests without memory issues

## Usage

### Default Behavior (CSV Streaming)

By default, backtests now use CSV streaming:

```bash
bun run src/enhanced_backtest_runner.ts \
  --poolId 0x737ec... \
  --start "2025-08-21T00:00:00Z" \
  --end "2025-08-30T00:00:00Z" \
  --step 1000 \
  --strategy ./src/strategies/three_band_rebalancer_backtest.ts \
  --dataDir ../mmt_txs
```

### Explicit CSV Format

```bash
bun run src/enhanced_backtest_runner.ts \
  --format csv \
  [... other args ...]
```

### JSON Format (for small backtests only)

To get JSON output (not recommended for long backtests):

```bash
bun run src/enhanced_backtest_runner.ts \
  --format json \
  [... other args ...]
```

⚠️ **Warning**: JSON format buffers all data in memory and can cause OOM errors on large backtests.

## Output Files

CSV streaming creates 3 files in the `./snapshots/` directory:

### 1. Vault CSV

`vault_<poolId>_<timestamp>.csv`

**Columns**:

- Timestamp, TimestampISO
- TotalValueUSD, TotalReturn, TotalReturnPct
- UnrealizedPnL, RealizedPnL, TotalFeesUSD
- TotalPositions, ActivePositions, InRangePositions
- TokenABalance, TokenBBalance, TokenAPrice, TokenBPrice
- CapitalEfficiency, LiquidityUtilization
- ImpermanentLoss, ImpermanentLossPct
- Risk metrics: Sharpe, Sortino, MaxDrawdown, ValueAtRisk, etc.

**Frequency**: One row per minute

### 2. Position CSV

`positions_<poolId>_<timestamp>.csv`

**Columns**:

- timestamp, position_id, vault_id
- event_type, action_type, pool_address
- min_price, max_price, current_price
- position_width_percentage
- token_a_amount, token_b_amount
- current_liquidity_usd, start_liquidity_usd
- fee_earned, position_return_usd, position_return_percentage
- il, apr
- trigger_reason, ai_explanation

**Frequency**: One row per position per minute

### 3. Summary CSV

`summary_<poolId>_<timestamp>.csv`

**Columns**:

- Timestamp, TimestampISO
- TotalPositions, ActivePositions, InRangePositions, OutOfRangePositions
- TotalLiquidity, TotalValueUSD, TotalFeesUSD
- AverageTickWidth
- PositionsBelow, PositionsInRange, PositionsAbove
- Performance metrics: AvgUnrealizedPnL, AvgROI, AvgSharpeRatio
- Risk metrics: PortfolioVolatility, MaxDrawdown, ValueAtRisk

**Frequency**: One row per minute

## Memory Comparison

### Before (JSON buffering):

- 20-day backtest: ~2-5 GB RAM
- Risk of OOM on long backtests
- No progress visibility

### After (CSV streaming):

- 20-day backtest: ~200-500 MB RAM (10x reduction)
- Can run indefinitely long backtests
- Watch progress in real-time: `tail -f snapshots/vault_*.csv`

## Monitoring Live Backtests

Watch vault performance in real-time:

```bash
tail -f snapshots/vault_*.csv | cut -d, -f1,2,3,6
```

Count position snapshots:

```bash
wc -l snapshots/positions_*.csv
```

Check summary metrics:

```bash
tail -1 snapshots/summary_*.csv
```

## Implementation Details

### Files Modified

1. **src/enhanced_backtest_runner.ts**

   - Added `streamCsv` config option
   - Changed default output format to `csv`
   - Skip JSON generation when streaming

2. **src/backtest_engine.ts**

   - Enable CSV streaming on snapshot trackers at initialization

3. **src/position_snapshot_tracker.ts**

   - Added `enableCsvStreaming()` method
   - Added `writePositionCsvRow()` and `writeSummaryCsvRow()` methods
   - Modified `captureSnapshot()` to write immediately when streaming enabled

4. **src/vault_snapshot_tracker.ts**
   - Added `enableCsvStreaming()` method
   - Added `writeVaultCsvRow()` method
   - Modified `captureSnapshot()` to write immediately when streaming enabled

### How It Works

1. At backtest start, CSV headers are written to files
2. Every minute, when snapshots are captured:
   - Data is formatted as CSV row
   - Row is appended to CSV file immediately (using `fs.appendFileSync`)
   - Data is NOT stored in memory arrays (unless JSON output is requested)
3. At backtest end, CSV files are already complete

## Best Practices

1. **Use CSV by default**: Only use JSON for analysis/debugging on small datasets
2. **Monitor disk space**: Long backtests generate large CSV files
3. **Timestamp in filenames**: Files include timestamp to avoid overwrites
4. **Import to tools**: CSV files can be easily imported to Excel, Python pandas, or databases

## Example Analysis

### Python (pandas)

```python
import pandas as pd

# Load vault data
vault_df = pd.read_csv('snapshots/vault_<poolId>_<timestamp>.csv')
vault_df['TimestampISO'] = pd.to_datetime(vault_df['TimestampISO'])

# Plot performance
import matplotlib.pyplot as plt
plt.plot(vault_df['TimestampISO'], vault_df['TotalValueUSD'])
plt.title('Vault Value Over Time')
plt.show()
```

### Excel

1. Open Excel
2. Data → From Text/CSV
3. Select the CSV file
4. Create pivot tables and charts

## Troubleshooting

### CSV files not created?

- Check `./snapshots/` directory exists
- Verify write permissions
- Look for errors in console output

### Missing data in CSV?

- Ensure backtest ran for at least 1 minute
- Check snapshot interval (default: 60 seconds)

### Want both CSV and JSON?

```bash
bun run src/enhanced_backtest_runner.ts --format both [...]
```

⚠️ Still uses memory for JSON, but CSV is also streamed.

## Performance Tips

1. **Adjust snapshot interval**: Modify `snapshotInterval` in trackers (default: 60s)
2. **Disable detailed reports**: Use `--no-detailed-report` for faster execution
3. **Larger step size**: Use `--step 5000` for quicker backtests (less granular)

## Future Enhancements

- [ ] Compressed CSV output (gzip)
- [ ] Parquet format support
- [ ] S3/cloud storage streaming
- [ ] Real-time visualization dashboard
- [ ] Incremental analysis during backtest
