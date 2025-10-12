# Token Parameters Implementation

## Overview

Added support for configurable token names and decimals to make backtest reports clearer and more flexible.

## Changes Implemented

### 1. New Command-Line Parameters

Both `backtest_runner.ts` and `enhanced_backtest_runner.ts` now accept:

```bash
--tokenAName <name>       # Name of Token A (base token), e.g., "USDC"
--tokenADecimals <number> # Decimals for Token A, e.g., "9"
--tokenBName <name>       # Name of Token B (quote token), e.g., "USDT"
--tokenBDecimals <number> # Decimals for Token B, e.g., "9"
```

**Defaults:**

- Token names: "TokenA" and "TokenB"
- Decimals: 9 for both tokens

### 2. Updated Files

#### `src/backtest_runner.ts`

- Added token parameter parsing
- Sets environment variables for token metadata
- Displays token configuration on startup

#### `src/enhanced_backtest_runner.ts`

- Added token parameter parsing
- Sets environment variables for token metadata
- Displays token configuration on startup

#### `src/position_snapshot_tracker.ts`

- Updated `calculateTokenValue()` to use configurable decimals
- Updated display labels to show actual token names instead of generic "TokenB"
- Fee display now shows: `0.1216 USDT (USDC: 0.051555, USDT: 0.070004)`

#### `backtest.sh`

- Added token parameters to command
- Added comment clarifying that costs are in Token B (quote currency):
  ```bash
  # All costs (ACTION_COST_B, MIN_PROFIT_B) are in Token B (quote currency)
  THREEBAND_ACTION_COST_B=0.02  # Cost per rebalance in Token B
  ```

### 3. Example Usage

#### Updated backtest.sh

```bash
bun run src/enhanced_backtest_runner.ts \
  --poolId 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 \
  --start "2025-08-20T00:00:00Z" \
  --end "2025-09-10T00:00:00Z" \
  --step 1000 \
  --format csv \
  --strategy ./src/strategies/three_band_rebalancer_backtest.ts \
  --dataDir ../mmt_txs \
  --tokenAName USDC \
  --tokenADecimals 9 \
  --tokenBName USDT \
  --tokenBDecimals 9
```

#### Output Example

**Token Configuration:**

```
💱 Token Configuration:
   Token A: USDC (9 decimals)
   Token B: USDT (9 decimals)
   Quote Currency: USDT
```

**Position Status:**

```
📊 Position Status [2025-08-20T00:00:00.000Z] | Market Price: 1.00055386
════════════════════════════════════════════════════════════════════════════════
   Total: 3 | Active: 2 | In-Range: 1 🟢 | Out: 2 ⚪
   Value: 0.00 USDT | Fees This Tick: 0.1216 USDT | Total Fees: 0.12 USDT

   Position Details:
   1. 🟢 IN-RANGE | ID: 4_6_75667485
      💰 Fees: 0.0000 USDT (USDC: 0.000000, USDT: 0.000000) | APR: 0.00%

   2. ⬆️  ABOVE | ID: 2_4_94410809
      💰 Fees: 0.1216 USDT (USDC: 0.051555, USDT: 0.070004) | APR: 239389.95%
```

### 4. Token Conventions

**Uniswap V3 Standard:**

```
Token0 (tokenA) = BASE token   (token with lower address)
Token1 (tokenB) = QUOTE token  (token with higher address)
Price = amount of Token1 per 1 Token0
```

**Example: USDC/USDT Pool**

```
If USDC has lower address:
  Token A (Token0) = USDC (base)
  Token B (Token1) = USDT (quote)
  Price = 1.00055 means 1 USDC = 1.00055 USDT
  All values quoted in USDT
```

### 5. Cost Parameters Clarification

**Important:** All cost parameters are denominated in Token B (quote token):

```bash
# backtest.sh
THREEBAND_ACTION_COST_A=0        # Cost in Token A (usually 0)
THREEBAND_ACTION_COST_B=0.02     # Cost in Token B (e.g., 0.02 USDT per rebalance)
THREEBAND_MIN_PROFIT_B=0.001     # Min profit in Token B (e.g., 0.001 USDT)
```

**Why Token B?**

- Token B is the quote currency
- All values are converted to Token B for comparison
- Makes cost calculations consistent

### 6. Decimal Handling

The system now correctly handles different decimal places:

```typescript
// Example with 6 decimals (USDC on Ethereum)
--tokenADecimals 6

// Example with 9 decimals (SUI tokens)
--tokenADecimals 9

// Example with 18 decimals (most ERC-20 tokens)
--tokenADecimals 18
```

**Conversion:**

```
Raw amount: 1000000000
Decimals: 9
Displayed: 1.0
```

### 7. Common Token Configurations

#### SUI Network Stablecoins (9 decimals)

```bash
--tokenAName USDC --tokenADecimals 9 \
--tokenBName USDT --tokenBDecimals 9
```

#### Ethereum Stablecoins (6 decimals)

```bash
--tokenAName USDC --tokenADecimals 6 \
--tokenBName USDT --tokenBDecimals 6
```

#### ETH/USDC (18 and 6 decimals)

```bash
--tokenAName ETH --tokenADecimals 18 \
--tokenBName USDC --tokenBDecimals 6
```

### 8. Benefits

1. **Clearer Output**: Shows actual token names instead of generic "Token0/Token1"
2. **Correct Decimals**: Handles any token decimal configuration
3. **Better Analysis**: Easy to understand costs and fees in familiar terms
4. **Flexibility**: Works with any token pair
5. **Documentation**: Clear labeling of quote currency

### 9. Migration from Old Code

**Old Output:**

```
Value: 0.00 TokenB
Fees: 0.1216 TokenB (Token0: 0.051555, Token1: 0.070004)
```

**New Output:**

```
Value: 0.00 USDT
Fees: 0.1216 USDT (USDC: 0.051555, USDT: 0.070004)
```

**No breaking changes** - defaults maintain backwards compatibility.

### 10. Environment Variables

The system uses these environment variables (set automatically):

```bash
TOKEN_A_NAME        # e.g., "USDC"
TOKEN_A_DECIMALS    # e.g., "9"
TOKEN_B_NAME        # e.g., "USDT"
TOKEN_B_DECIMALS    # e.g., "9"
```

These are accessible throughout the codebase for consistent formatting.

## Testing

Tested with:

- ✅ USDC/USDT pool (9 decimals each)
- ✅ Both backtest_runner.ts and enhanced_backtest_runner.ts
- ✅ Per-minute position tracking
- ✅ Fee calculations
- ✅ CSV output headers

## Summary

| Feature           | Before                       | After                    |
| ----------------- | ---------------------------- | ------------------------ |
| **Token Names**   | Generic "TokenB"             | Actual names "USDT"      |
| **Decimals**      | Hardcoded 1e9                | Configurable via params  |
| **Display**       | `0.1216 TokenB`              | `0.1216 USDT`            |
| **Fee Breakdown** | `Token0: 0.05, Token1: 0.07` | `USDC: 0.05, USDT: 0.07` |
| **Configuration** | None                         | Command-line params      |
| **Clarity**       | Low                          | High ✅                  |

---

**Status: FULLY IMPLEMENTED AND TESTED** ✅

All token parameters are now configurable, costs are clearly denominated in Token B (quote currency), and output is human-readable with actual token names.
