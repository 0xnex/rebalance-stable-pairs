# MaxLiquidityResult Fields Explained

## What does `maxLiquidity()` do?

Given input tokens (amount0, amount1), the function:
1. **Optionally swaps** to achieve the optimal ratio for maximum liquidity
2. **Deposits** both tokens into a liquidity position
3. **Returns** what's left over

---

## Return Fields

### 📊 Liquidity Created
- **`liquidity`** - The amount of liquidity created in the position

### 💰 Deposited Amounts (What went into the position)
- **`depositedAmount0`** - Amount of token0 deposited into liquidity (always ≥ 0)
- **`depositedAmount1`** - Amount of token1 deposited into liquidity (always ≥ 0)

### 🎁 Leftover Amounts (What remains)
- **`remain0`** - Amount of token0 left over (always ≥ 0)
- **`remain1`** - Amount of token1 left over (always ≥ 0)
- **`actualRemain0`** - Same as `remain0` (kept for compatibility)
- **`actualRemain1`** - Same as `remain1` (kept for compatibility)

### 💸 Swap Costs (if a swap happened)
- **`swapFee0`** - Fee paid in token0 (> 0 if swapped token0→token1, else 0)
- **`swapFee1`** - Fee paid in token1 (> 0 if swapped token1→token0, else 0)

### 📉 Slippage (loss from price impact)
- **`slip0`** - Slippage lost in token0 (> 0 if swapped token1→token0, else 0)
- **`slip1`** - Slippage lost in token1 (> 0 if swapped token0→token1, else 0)

---

## Key Rules

1. **Fee** is paid in the **INPUT** token of the swap (deducted before swap)
2. **Slippage** reduces the **OUTPUT** token of the swap (less received than expected)
3. Only one of `(swapFee0, swapFee1)` will be > 0
4. Only one of `(slip0, slip1)` will be > 0
5. All amounts are **always positive** (no confusing negatives!)

---

## Example

**Input:** 0 suiUSDT, 6000 USDC

**What happens:**
1. Swap 1392 USDC → 1384 suiUSDT
   - Fee: 0.3 USDC (paid in input token)
   - Slippage: 15 suiUSDT (lost in output token)
2. Deposit into liquidity: 2983 suiUSDT + 2985 USDC

**Result:**
```typescript
{
  liquidity: 59683584995884n,
  
  // What was deposited into the position
  depositedAmount0: 2983209596n,  // 2983.21 suiUSDT
  depositedAmount1: 2984701499n,  // 2984.70 USDC
  
  // What's left over
  remain0: 1n,           // 0.000001 suiUSDT
  remain1: 15298500n,    // 15.30 USDC
  
  // Swap costs
  swapFee0: 0n,          // No fee in suiUSDT
  swapFee1: 300000n,     // 0.3 USDC fee
  slip0: 14991003n,      // 14.99 suiUSDT slippage
  slip1: 0n,             // No slippage in USDC
}
```

**Log output:**
```
Input: 0 suiUSDT, 6000 USDC
Deposited: 2983.21 suiUSDT, 2984.70 USDC
Remain: 0.000001 suiUSDT, 15.30 USDC
Swap: USDC→suiUSDT
Fee: 0 suiUSDT, 0.3 USDC
Slip: 14.99 suiUSDT, 0 USDC
```

---

## Visual Flow

```
Start: 0 suiUSDT, 6000 USDC
   │
   ├─→ Swap: 1392 USDC → 1384 suiUSDT
   │   ├─ Fee: 0.3 USDC (paid before swap)
   │   └─ Slippage: 15 suiUSDT (received less than expected)
   │
   ├─→ Deposit: 2983 suiUSDT + 2985 USDC → Liquidity Position
   │
   └─→ Leftover: 0.000001 suiUSDT, 15.30 USDC
```

---

## Where to find the code

- Type definition: `src/liquidity_calculator.ts` (lines 26-81)
- Implementation: `src/liquidity_calculator.ts` - `maxLiquidity()` function
- Tests: `tests/liquidity_calculator.test.ts`
- Usage: `src/virtual_position_mgr.ts` - `createPosition()` method

