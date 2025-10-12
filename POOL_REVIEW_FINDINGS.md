# Pool.ts Code Review - Critical Issues Found

## 🔴 CRITICAL ISSUE #1: BigInt Underflow in Fee Calculation

### Location
`calculateFeeGrowthInside()` function (lines 471-509)

### Problem
```typescript
// Lines 495, 497, 500-501
if (this.tickCurrent < tickLower) {
  feeGrowthInside = feeGrowthOutsideLower - feeGrowthOutsideUpper;
} else if (this.tickCurrent >= tickUpper) {
  feeGrowthInside = feeGrowthOutsideUpper - feeGrowthOutsideLower;
} else {
  feeGrowthInside = globalFeeGrowth - feeGrowthOutsideLower - feeGrowthOutsideUpper;
}
```

**Issue**: BigInt subtraction can underflow! 

When `feeGrowthOutsideLower < feeGrowthOutsideUpper`, the result will wrap around to a massive positive number instead of being negative.

**Impact**: 
- Incorrect fee calculations
- Positions may show astronomically high fees
- Fee tracking completely broken in certain scenarios

### Fix Required
Need to handle wrap-around for Q64.64 fixed-point arithmetic:

```typescript
// Helper function needed
private submod(a: bigint, b: bigint, mod: bigint = 2n ** 256n): bigint {
  const diff = a - b;
  return diff < 0n ? diff + mod : diff;
}

// Then use in calculateFeeGrowthInside:
if (this.tickCurrent < tickLower) {
  feeGrowthInside = this.submod(feeGrowthOutsideLower, feeGrowthOutsideUpper);
} else if (this.tickCurrent >= tickUpper) {
  feeGrowthInside = this.submod(feeGrowthOutsideUpper, feeGrowthOutsideLower);
} else {
  const temp = this.submod(globalFeeGrowth, feeGrowthOutsideLower);
  feeGrowthInside = this.submod(temp, feeGrowthOutsideUpper);
}
```

---

## ⚠️  ISSUE #2: Fee Growth Update Only for LP Fees

### Location
`applySwapInternal()` function (line 265)

### Problem
```typescript
if (lpFee > 0n) {
  this.updateFeeGrowth(lpFee, zeroForOne);
}
```

**Issue**: Only LP fees update global fee growth. Protocol fees are excluded.

**Question**: Is this intentional? In standard Uniswap V3:
- Only LP fees go into feeGrowthGlobal
- Protocol fees are collected separately

**Verification Needed**: Confirm this matches the on-chain implementation.

---

## ⚠️  ISSUE #3: Fee Calculation Rounding

### Location
`calculateFees()` function (lines 644-679)

### Problem
```typescript
const rawFee = (amountIn * ppm + 1_000_000n - 1n) / 1_000_000n; // ceil
let lpFee = (rawFee * 4n + 5n - 1n) / 5n; // ceil(0.8 * rawFee)
```

**Issue**: Using ceiling for BOTH calculations compounds rounding errors.

**Standard Approach**:
- Ceiling for total fee (benefits protocol)
- Floor or standard division for LP vs protocol split

**Impact**: Small but accumulates over many swaps, slightly favoring LPs.

---

## ⚠️  ISSUE #4: Price Impact Calculation

### Location
`calculatePriceImpact()` function (lines 715-735)

### Problem
```typescript
if (zeroForOne) {
  effectivePrice = Number(amountOut) / Number(amountIn);
} else {
  effectivePrice = Number(amountOut) / Number(amountIn);
}
```

**Issue**: Both branches do the SAME calculation! This is clearly wrong.

**Expected**:
```typescript
if (zeroForOne) {
  // Swapping A for B: price = B/A
  effectivePrice = Number(amountOut) / Number(amountIn);
} else {
  // Swapping B for A: price = A/B (need to invert)
  effectivePrice = Number(amountIn) / Number(amountOut);
}
```

**Impact**: Price impact calculations are incorrect for one direction of swaps.

---

## ℹ️  OBSERVATION #5: Fee Growth Outside Initialization

### Location
`updateTickData()` function (lines 100-122)

### Code
```typescript
this.ticks.set(tick, {
  liquidityNet: 0n,
  liquidityGross: 0n,
  feeGrowthOutside0X64: 0n,  // ← Always starts at 0
  feeGrowthOutside1X64: 0n,
});
```

**Question**: Should `feeGrowthOutside` be initialized to:
- `0n` (current) - if tick is above current tick?
- `globalFeeGrowth` - if tick is below current tick?

This matters for correct fee accounting when ticks are first initialized.

**Standard Uniswap V3**: Initializes based on current tick position.

---

## ℹ️  OBSERVATION #6: Liquidity Update Timing

### Location
`executeCLMMSwap()` function (lines 340-355)

### Code
```typescript
// Update fee growth AFTER price crosses tick
this.updateFeeGrowthOutside(nextTick, zeroForOne);

// THEN update liquidity
const tickData = this.ticks.get(nextTick);
if (tickData) {
  const liquidityNet = tickData.liquidityNet;
  if (zeroForOne) {
    this.liquidity -= liquidityNet;
  } else {
    this.liquidity += liquidityNet;
  }
}
```

**Question**: Should fee growth update happen BEFORE or AFTER liquidity changes?

**Standard**: Fee growth outside should be updated BEFORE crossing (with old liquidity state).

---

## 🔍 OBSERVATION #7: updateFeeGrowthOutside Implementation

### Location
`updateFeeGrowthOutside()` function (lines 510-523)

### Code
```typescript
updateFeeGrowthOutside(tick: number, zeroForOne: boolean) {
  const tickData = this.ticks.get(tick);
  if (!tickData) return;

  const globalFeeGrowth = zeroForOne
    ? this.feeGrowthGlobal0X64
    : this.feeGrowthGlobal1X64;

  if (zeroForOne) {
    tickData.feeGrowthOutside0X64 = globalFeeGrowth;
  } else {
    tickData.feeGrowthOutside1X64 = globalFeeGrowth;
  }
}
```

**Issue**: Only updates fee growth for the token being swapped!

**Should it**: Update BOTH tokens' fee growth outside when crossing a tick?

In Uniswap V3, crossing a tick flips the accounting for both tokens.

---

## Summary Table

| Issue | Severity | Impact | Fix Complexity |
|-------|----------|--------|----------------|
| #1: BigInt Underflow | 🔴 CRITICAL | Fee calculations completely broken | Medium |
| #2: Protocol Fee Exclusion | ⚠️  WARNING | May be intentional | Verify |
| #3: Fee Rounding | ⚠️  WARNING | Minor accumulated error | Low |
| #4: Price Impact | ⚠️  WARNING | Wrong for one direction | Low |
| #5: Fee Growth Init | ℹ️  INFO | May cause fee discrepancies | Medium |
| #6: Liquidity Timing | ℹ️  INFO | Verify against spec | Low |
| #7: Fee Growth Update | ℹ️  INFO | May need both tokens | Medium |

---

## Recommendations

### Immediate (Critical)
1. ✅ Fix BigInt underflow in `calculateFeeGrowthInside` (Issue #1)
2. ✅ Fix price impact calculation (Issue #4)

### High Priority
3. Review fee growth outside initialization logic (Issue #5)
4. Verify updateFeeGrowthOutside updates both tokens (Issue #7)

### Medium Priority
5. Verify protocol fee handling matches on-chain behavior (Issue #2)
6. Verify liquidity update timing (Issue #6)
7. Review fee rounding strategy (Issue #3)

### Testing Needed
- Unit tests for fee calculations with various tick positions
- Edge cases: tick crossings, multiple positions, fee accumulation
- Compare against on-chain contract behavior

