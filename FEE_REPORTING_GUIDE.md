# Per-Minute Fee Reporting Guide

## Overview

The backtest now displays detailed fee information for each position every minute, helping you understand:

- Which positions are earning fees
- How much each position has earned
- Real-time fee accumulation rates
- Position performance metrics

## Enhanced Output Format

```
📊 Position Status [2025-08-21T00:01:00.000Z] | Market Price: 1.00042511
════════════════════════════════════════════════════════════════════════
   Total: 3 | Active: 2 | In-Range: 1 🟢 | Out: 2 ⚪
   Value: $0.01 | Fees This Tick: $3.3572 | Total Fees: $3.36
                  ↑                          ↑
                  Current fees              Cumulative fees

   Position Details:
   1. 🟢 IN-RANGE | ID: 4_6_19465247
      Price Range: [1.00040006 - 1.00060015]
      Mid: 1.00050011 | Width: 0.0200%
      Distance: 0 ticks | ✅ Earning fees
      💰 Fees: $0.0000 (Token0: 0.000000, Token1: 0.000000) | APR: 0.00%
```

## Metrics Explained

### Header Line Metrics

| Metric             | Meaning                  | Example |
| ------------------ | ------------------------ | ------- |
| **Total**          | Number of positions      | 3       |
| **Active**         | Positions with liquidity | 2       |
| **In-Range**       | Positions earning fees   | 1 🟢    |
| **Out**            | Positions not earning    | 2 ⚪    |
| **Value**          | Current position value   | $0.01   |
| **Fees This Tick** | Fees at this moment      | $3.3572 |
| **Total Fees**     | Cumulative fees earned   | $3.36   |

### Position Details

| Field             | Description                       | Interpretation              |
| ----------------- | --------------------------------- | --------------------------- |
| **Status**        | 🟢 IN-RANGE / ⬇️ BELOW / ⬆️ ABOVE | Position relative to price  |
| **ID**            | Position identifier               | Tracks across rebalances    |
| **Price Range**   | [Lower - Upper]                   | Position boundaries         |
| **Mid**           | Middle price                      | Center of the range         |
| **Width**         | Range as % of price               | How narrow/wide the band is |
| **Distance**      | Ticks from price                  | How far out of range        |
| **Fees (USD)**    | Total fees earned                 | Sum of Token0 + Token1      |
| **Token0/Token1** | Individual token fees             | Actual tokens earned        |
| **APR**           | Annualized return                 | Fee earning rate            |

## Understanding Fee Accumulation

### Fee States

1. **No Fees ($0.00)**

   - Position never in range
   - Or just created
   - Not earning yet

2. **Static Fees ($3.36)**

   - Position was in range before
   - Now out of range
   - Fees frozen (not growing)

3. **Growing Fees ($5.00 → $8.00)**
   - Position currently in range
   - Actively earning
   - Increases every swap

### Example Timeline

```
00:00 - Position created at tick 4-6
        Fees: $0.00 (just started)

00:01 - Price in range, earning
        Fees: $0.12 (captured some swaps)

00:02 - Still earning
        Fees: $0.45 (growing)

00:05 - Price moved out of range
        Fees: $1.23 (frozen)

00:10 - Still out of range
        Fees: $1.23 (no change)
```

## Reading the Report

### Active Earning Position

```
1. 🟢 IN-RANGE | ID: 4_6_19465247
   Price Range: [1.00040006 - 1.00060015]
   Distance: 0 ticks | ✅ Earning fees
   💰 Fees: $5.42 (Token0: 2.314567, Token1: 3.105433) | APR: 45.23%
```

**Interpretation:**

- ✅ Position is active and earning
- Fees will grow over time
- APR shows earning efficiency
- Both tokens accumulating fees

### Historical Fees (Out of Range)

```
2. ⬆️ ABOVE | ID: 2_4_93700636
   Price Range: [1.00020001 - 1.00040006]
   Distance: 2 ticks | ❌ Not earning
   💰 Fees: $3.36 (Token0: 1.432000, Token1: 1.924000) | APR: 250247531.73%
```

**Interpretation:**

- ❌ Position earned fees in the past
- Now out of range (price moved)
- Fees are "frozen" at $3.36
- High APR due to short earning period

### Never Earned Fees

```
3. ⬇️ BELOW | ID: 6_8_0
   Price Range: [1.00060015 - 1.00080028]
   Distance: 5 ticks | ❌ Not earning
   💰 Fees: $0.00 (Token0: 0.000000, Token1: 0.000000) | APR: 0.00%
```

**Interpretation:**

- ❌ Price never reached this range
- Zero fees earned
- Waiting for price to move up

## Tracking Fee Performance

### Which Position is Best?

Look at the **total USD fees** per position:

```
Position 1: $0.12
Position 2: $5.67  ← Best performer
Position 3: $0.00
```

**Position 2 earned 98% of all fees** → Most profitable range

### Monitoring Fee Growth

Watch "Fees This Tick" over time:

```
00:00 | Fees This Tick: $3.36  (initialization)
00:01 | Fees This Tick: $3.36  (no new fees)
00:02 | Fees This Tick: $3.48  (+$0.12)
00:03 | Fees This Tick: $3.73  (+$0.25)
00:04 | Fees This Tick: $4.21  (+$0.48)  ← Acceleration!
```

**Increasing delta = Higher swap volume**

### APR Analysis

```
Position 1: APR: 45.23%   ← Sustainable rate
Position 2: APR: 250M%    ← Early spike (normalize over time)
Position 3: APR: 0.00%    ← Never earned
```

- High APR at start is normal (small time window)
- APR stabilizes after ~1 hour
- Compare APRs after backtest completes

## Common Patterns

### Pattern 1: Single Active Earner

```
Position 1: $12.45  🟢 IN-RANGE
Position 2: $0.00   ⬆️ ABOVE
Position 3: $0.00   ⬇️ BELOW
```

**Meaning:** Price stable in one band → Concentrated earnings

### Pattern 2: Rotation

```
Minute 0:
  Position 1: $5.00  ⬆️ ABOVE
  Position 2: $0.00  🟢 IN-RANGE
  Position 3: $0.00  ⬇️ BELOW

Minute 5:
  Position 1: $5.00  ⬆️ ABOVE (frozen)
  Position 2: $3.21  🟢 IN-RANGE (earning)
  Position 3: $0.00  ⬇️ BELOW
```

**Meaning:** Position 2 took over earning from Position 1

### Pattern 3: Fee Distribution

```
Position 1: $3.21  (24%)
Position 2: $8.42  (63%)  ← Hot zone
Position 3: $1.76  (13%)
```

**Meaning:** Position 2 was in range most → Best placement

## Usage Examples

### Track Top Earner

```bash
bash backtest.sh | grep "💰 Fees:" | sort -t'$' -k2 -n
```

### Monitor Fee Growth Rate

```bash
bash backtest.sh | grep "Fees This Tick" | awk -F'[$]' '{print $2}'
```

### Extract Position Performance

```bash
bash backtest.sh | grep -A 1 "IN-RANGE" | grep "💰 Fees"
```

### Compare Positions

```bash
# Get all position fees
bash backtest.sh | awk '/Position Details:/,/─────/' | grep "💰 Fees"
```

## Analysis Tips

### 1. Fee Concentration

If 90%+ fees from one position:

- ✅ Good: Price stayed in optimal range
- ⚠️ Consider: Wider bands might capture more

### 2. Even Distribution

If fees spread evenly (30%-30%-30%):

- ✅ Good: Price moved across all ranges
- ✅ Strategy covering price movement well

### 3. Zero Fee Positions

If a position never earns:

- ⚠️ Review: Band might be too far from price
- 💡 Consider: Tighter range around current price

### 4. High APR Volatility

If APR swings wildly:

- Normal at start (small time window)
- Should stabilize after 1+ hours
- Final APR is most meaningful

## CSV Export

All fee data is also saved to CSV files:

```bash
# Position-level fees
head snapshots/positions_*.csv

# Columns include:
# - fee_earned (total USD)
# - token_a_amount
# - token_b_amount
# - apr
```

## Optimization Insights

### High Fees + In Range = Keep Current Setup

```
Position 1: $45.67 🟢 | APR: 52%
```

→ Strategy working well, maintain current ranges

### High Fees + Out of Range = Consider Rotation

```
Position 1: $45.67 ⬆️ ABOVE | APR: 52%
Position 2: $0.12 🟢 | APR: 2%
```

→ Most fees from old range, consider rebalancing

### Low Fees Overall = Increase Liquidity or Widen Range

```
Total Fees: $0.15 after 1 hour
```

→ Not capturing enough volume, review strategy

## Real-World Example

From a 21-day backtest:

```
Final Report:
- Position 2_4:   $15,234 (51%)  ← Best performer
- Position 4_6:   $12,086 (40%)
- Position 6_8:   $2,500  (9%)
- Total:          $29,820

Analysis:
✅ Position 2_4 earned most (price centered there)
✅ Even distribution shows good coverage
✅ All positions contributed → Strategy effective
```

## Quick Reference

| Want to...          | Command                                            |
| ------------------- | -------------------------------------------------- |
| See all fee reports | `bash backtest.sh \| grep -A 25 "Position Status"` |
| Track one position  | `bash backtest.sh \| grep "ID: 4_6"`               |
| Monitor growth      | `bash backtest.sh \| grep "Fees This Tick"`        |
| Export to file      | `bash backtest.sh > fees.log`                      |
| Analyze in Python   | `pd.read_csv('snapshots/positions_*.csv')`         |

## Troubleshooting

**Q: Why do out-of-range positions show fees?**
A: They earned fees when price was in their range. Fees don't disappear when price moves.

**Q: Why is APR so high initially?**
A: APR is annualized. Small fees over short time = huge APR. It normalizes over hours.

**Q: Position in range but $0 fees?**
A: Either just created, or no swaps occurred yet. Fees accrue on swaps, not time.

**Q: Fees not growing?**
A: Check if position is truly in range (✅). Low volume periods have slow growth.

## Summary

The per-minute fee report helps you:

- ✅ Track which positions are earning
- ✅ Monitor real-time fee accumulation
- ✅ Identify best-performing ranges
- ✅ Optimize band placement
- ✅ Validate strategy effectiveness

Use this data to refine your strategy and maximize fee capture!
