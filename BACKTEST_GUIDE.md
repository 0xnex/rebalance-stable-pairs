# Backtest Entry Program - User Guide

## Overview

The backtest entry program (`src/backtest.ts`) provides a command-line interface for running backtests of liquidity management strategies against historical on-chain events.

## Features

✅ **Complete CLI Argument Parsing**
  - Required: pool ID, start/end dates
  - Optional: initial balances, data directory, output format
  - Flexible argument aliases (e.g., `-p` or `--poolId`)

✅ **Service Builder**
  - Automatic pool initialization
  - Position manager creation
  - Slippage provider configuration
  - Event import and replay

✅ **Multiple Output Formats**
  - Table (human-readable)
  - JSON (machine-readable)
  - CSV (spreadsheet-friendly)

✅ **Performance CSV Export**
  - Fund-level metrics
  - Position-level metrics
  - Automatic directory creation

✅ **Configurable Slippage Models**
  - Fixed slippage rate
  - Linear slippage (scales with trade size)
  - Adjustable maximum cap

---

## Installation

No additional installation required. The program uses existing dependencies.

---

## Usage

### Basic Syntax

```bash
bun run src/backtest.ts --poolId <ID> --start <DATE> --end <DATE> [OPTIONS]
```

### Required Arguments

| Argument | Alias | Type | Description |
|----------|-------|------|-------------|
| `--poolId` | `-p` | string | Pool ID (hex string starting with 0x) |
| `--start` | `-s` | ISO date | Start timestamp (e.g., "2025-08-20T00:00:00Z") |
| `--end` | `-e` | ISO date | End timestamp (e.g., "2025-08-21T00:00:00Z") |

### Optional Arguments

#### Initial Balances
| Argument | Alias | Type | Default | Description |
|----------|-------|------|---------|-------------|
| `--initialAmount0` | `--init0` | bigint | 10000000 | Initial amount of token0 (6 decimals = 10 tokens) |
| `--initialAmount1` | `--init1` | bigint | 10000000 | Initial amount of token1 (6 decimals = 10 tokens) |

#### Data and Output
| Argument | Alias | Type | Default | Description |
|----------|-------|------|---------|-------------|
| `--dataDir` | `-d` | path | auto-detect | Events data directory |
| `--output` | `-o` | path | stdout | Output file path |

#### Slippage Configuration
| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `--slippageModel` | "fixed"\|"linear" | "fixed" | Slippage estimation model |
| `--slippageRate` | float | 0.001 | Base slippage rate (0.1%) |
| `--maxSlippage` | float | 0.05 | Maximum slippage cap (5%) |

#### Pool Configuration
| Argument | Type | Default | Description |
|----------|------|---------|-------------|
| `--tickSpacing` | int | 10 | Tick spacing for the pool |
| `--feeTier` | int | 3000 | Fee tier in PPM (0.3%) |

#### Output and Display
| Argument | Alias | Type | Default | Description |
|----------|-------|------|---------|-------------|
| `--format` | `-f` | "table"\|"json"\|"csv" | "table" | Output format |
| `--exportCsv` | - | flag | false | Export performance CSVs |
| `--csvDir` | - | path | "./backtest-results" | CSV export directory |
| `--silent` | - | flag | false | Suppress progress logs |

#### Help
| Argument | Alias | Description |
|----------|-------|-------------|
| `--help` | `-h` | Show help message |

---

## Examples

### 1. Basic Backtest (1 Day)

Run a simple backtest with default settings (10 USDC + 10 USDT):

```bash
bun run src/backtest.ts \
  --poolId 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 \
  --start "2025-08-20T00:00:00Z" \
  --end "2025-08-21T00:00:00Z"
```

### 2. Custom Initial Balances

Test with 50 USDC + 50 USDT:

```bash
bun run src/backtest.ts \
  --poolId 0x737ec... \
  --start "2025-08-20T00:00:00Z" \
  --end "2025-08-21T00:00:00Z" \
  --initialAmount0 50000000 \
  --initialAmount1 50000000
```

### 3. Custom Data Directory

Specify a custom events directory:

```bash
bun run src/backtest.ts \
  --poolId 0x737ec... \
  --start "2025-08-20T00:00:00Z" \
  --end "2025-08-21T00:00:00Z" \
  --dataDir ./data/events
```

### 4. Export to JSON

Output results as JSON to a file:

```bash
bun run src/backtest.ts \
  --poolId 0x737ec... \
  --start "2025-08-20T00:00:00Z" \
  --end "2025-08-21T00:00:00Z" \
  --format json \
  --output ./results/backtest.json
```

### 5. Export Performance CSVs

Generate CSV reports for further analysis:

```bash
bun run src/backtest.ts \
  --poolId 0x737ec... \
  --start "2025-08-20T00:00:00Z" \
  --end "2025-08-30T00:00:00Z" \
  --exportCsv \
  --csvDir ./results/csv
```

### 6. Linear Slippage Model

Use linear slippage estimation instead of fixed:

```bash
bun run src/backtest.ts \
  --poolId 0x737ec... \
  --start "2025-08-20T00:00:00Z" \
  --end "2025-08-21T00:00:00Z" \
  --slippageModel linear \
  --slippageRate 0.0005 \
  --maxSlippage 0.01
```

### 7. Silent Mode with CSV Output

Suppress logs and only generate CSV:

```bash
bun run src/backtest.ts \
  --poolId 0x737ec... \
  --start "2025-08-20T00:00:00Z" \
  --end "2025-08-21T00:00:00Z" \
  --silent \
  --format csv \
  --output ./results/summary.csv
```

### 8. Long-Running Backtest (30 Days)

Test over an extended period:

```bash
bun run src/backtest.ts \
  --poolId 0x737ec... \
  --start "2025-08-01T00:00:00Z" \
  --end "2025-08-31T00:00:00Z" \
  --initialAmount0 100000000 \
  --initialAmount1 100000000 \
  --exportCsv \
  --csvDir ./results/august-2025
```

---

## Output Formats

### Table Format (Default)

Human-readable table with clear sections:

```
╔═══════════════════════════════════════════════════════════════════════╗
║                        BACKTEST RESULTS                               ║
╚═══════════════════════════════════════════════════════════════════════╝

📊 CONFIGURATION
───────────────────────────────────────────────────────────────────────
Pool ID:          0x737ec...
Start:            2025-08-20T00:00:00.000Z
End:              2025-08-21T00:00:00.000Z
Duration:         24.00 hours
Events Processed: 12453

💰 FUND PERFORMANCE
───────────────────────────────────────────────────────────────────────
Initial Value:      20,000,000 (token1)
Final Value:        20,015,234 (token1)
PnL:                    15,234 (token1)
ROI:                    0.0762%

Fee Earned:             18,500 (token1)
Slippage Cost:           2,100 (token1)
Swap Cost:               1,166 (token1)

🏊 POOL STATE
───────────────────────────────────────────────────────────────────────
Current Price:    0.99987654
Current Tick:     -12
Liquidity:        1,234,567,890
Reserve0:         10,005,123
Reserve1:         10,010,111

📈 POSITIONS (2)
───────────────────────────────────────────────────────────────────────
  pos1:
    Status:     active ✓ in-range
    Liquidity:  5,000,000
    PnL:        7,500 (0.0750%)
    Fees:       9,250

  pos2:
    Status:     active ✗ out-of-range
    Liquidity:  3,000,000
    PnL:        7,734 (0.0773%)
    Fees:       9,250

═══════════════════════════════════════════════════════════════════════
```

### JSON Format

Machine-readable structured data:

```json
{
  "config": {
    "poolId": "0x737ec...",
    "startTime": "2025-08-20T00:00:00.000Z",
    "endTime": "2025-08-21T00:00:00.000Z",
    "durationHours": 24,
    "initialAmount0": "10000000",
    "initialAmount1": "10000000",
    "slippageModel": "fixed",
    "slippageRate": 0.001
  },
  "events": {
    "count": 12453,
    "eventsPerHour": 518.875
  },
  "pool": {
    "currentPrice": 0.99987654,
    "currentTick": -12,
    "liquidity": "1234567890",
    "reserve0": "10005123",
    "reserve1": "10010111"
  },
  "fund": {
    "initialValue": "20000000",
    "totalValue": "20015234",
    "pnl": "15234",
    "roiPercent": 0.0762,
    "totalFeeEarned": "18500",
    "totalSlippageCost": "2100",
    "totalSwapCost": "1166"
  },
  "positions": [
    {
      "id": "pos1",
      "status": "active",
      "isInRange": true,
      "liquidity": "5000000",
      "pnl": "7500",
      "roiPercent": 0.075,
      "feeEarned": "9250"
    }
  ]
}
```

### CSV Format

Simple comma-separated values for spreadsheets:

```csv
metric,value
pool_id,0x737ec...
start_time,2025-08-20T00:00:00.000Z
end_time,2025-08-21T00:00:00.000Z
duration_hours,24.00
events_processed,12453
current_price,0.99987654
initial_value,20000000
total_value,20015234
pnl,15234
roi_percent,0.0762
total_fee_earned,18500
total_slippage_cost,2100
total_swap_cost,1166
num_positions,2
```

---

## Performance CSV Export

When using `--exportCsv`, two additional CSV files are generated:

### 1. Fund Performance CSV
`fund_performance_[timestamp].csv`

Contains a single row with all fund-level metrics. See `PERFORMANCE_METRICS.md` for field descriptions.

### 2. Position Performance CSV
`position_performance_[timestamp].csv`

Contains one row per position with detailed metrics. See `PERFORMANCE_METRICS.md` for field descriptions.

---

## Error Handling

The program performs validation on all inputs:

### Common Errors

1. **Missing required argument**
   ```
   Error: --poolId is required
   ```
   Solution: Provide all required arguments

2. **Invalid date format**
   ```
   Error: --start must be before --end
   ```
   Solution: Ensure start date is before end date

3. **Invalid pool ID**
   ```
   Error during backtest: Pool not found
   ```
   Solution: Check pool ID is correct

4. **Events directory not found**
   ```
   Error: ENOENT: no such file or directory
   ```
   Solution: Specify correct `--dataDir` or ensure events are available

---

## Integration with Existing Scripts

The backtest program can be integrated with existing shell scripts:

### npm/bun Scripts

Add to `package.json`:

```json
{
  "scripts": {
    "backtest": "bun run src/backtest.ts",
    "backtest:quick": "bun run src/backtest.ts --poolId 0x737ec... --start 2025-08-20T00:00:00Z --end 2025-08-21T00:00:00Z",
    "backtest:export": "bun run src/backtest.ts --exportCsv --csvDir ./results"
  }
}
```

### Shell Script Wrapper

```bash
#!/bin/bash
# backtest.sh - Wrapper for common backtest scenarios

POOL_ID="0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9"

case "$1" in
  "quick")
    bun run src/backtest.ts \
      --poolId "$POOL_ID" \
      --start "2025-08-20T00:00:00Z" \
      --end "2025-08-21T00:00:00Z"
    ;;
  
  "full")
    bun run src/backtest.ts \
      --poolId "$POOL_ID" \
      --start "2025-08-01T00:00:00Z" \
      --end "2025-08-31T00:00:00Z" \
      --exportCsv
    ;;
  
  *)
    echo "Usage: ./backtest.sh [quick|full]"
    exit 1
    ;;
esac
```

---

## Advanced Usage

### Custom Slippage Configuration

For stable pairs, use lower slippage:

```bash
--slippageModel fixed --slippageRate 0.0001 --maxSlippage 0.001
```

For volatile pairs, use higher slippage:

```bash
--slippageModel linear --slippageRate 0.005 --maxSlippage 0.02
```

### Batch Processing

Run multiple backtests with different configurations:

```bash
for init_amount in 10000000 50000000 100000000; do
  bun run src/backtest.ts \
    --poolId 0x737ec... \
    --start "2025-08-20T00:00:00Z" \
    --end "2025-08-21T00:00:00Z" \
    --initialAmount0 $init_amount \
    --initialAmount1 $init_amount \
    --format json \
    --output "./results/backtest_${init_amount}.json"
done
```

---

## Troubleshooting

### Problem: Out of Memory

**Solution**: Reduce the time range or increase Node.js memory:
```bash
NODE_OPTIONS="--max-old-space-size=8192" bun run src/backtest.ts ...
```

### Problem: Slow Performance

**Solution**: Use `--silent` to disable progress logs:
```bash
bun run src/backtest.ts --silent ...
```

### Problem: CSV Not Generated

**Solution**: Ensure `--exportCsv` flag is present:
```bash
bun run src/backtest.ts --exportCsv --csvDir ./results ...
```

---

## See Also

- `PERFORMANCE_METRICS.md` - Complete field documentation
- `PERFORMANCE_TRACKING_SUMMARY.md` - Implementation details
- `EVENT_IMPORTER_COMPLETE_REFACTORING.md` - Event import documentation
- `SLIPPAGE_ESTIMATION.md` - Slippage model details

---

## Version History

- **v1.0** (2025-10-24): Initial implementation
  - CLI argument parsing
  - Service builder
  - Multiple output formats
  - Performance CSV export

