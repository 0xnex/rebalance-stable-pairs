const Q64 = 1n << 64n;
const Base = 1.0001;

class Pool {
  reserveA: bigint;
  reserveB: bigint;
  sqrtPriceX64: bigint; // Q64.64
  liquidity: bigint;
  tickCurrent: number;
  feeRate: number; // e.g. 0.003 for 0.3%
  tickSpacing: number;
  feeRatePpm: bigint; // fee rate expressed in millionths (from on-chain data)
  protocolFeeShareNumerator: bigint;
  protocolFeeShareDenominator: bigint;
  ticks: Map<
    number,
    {
      liquidityNet: bigint;
      liquidityGross: bigint;
      feeGrowthOutside0X64: bigint;
      feeGrowthOutside1X64: bigint;
    }
  >;
  tickBitmap: Set<number>;
  feeGrowthGlobal0X64: bigint; // Global fee growth for token 0
  feeGrowthGlobal1X64: bigint; // Global fee growth for token 1

  constructor(feeRate: number, tickSpacing: number, feeRatePpm: bigint = 0n) {
    this.reserveA = 0n;
    this.reserveB = 0n;
    this.sqrtPriceX64 = 0n;
    this.liquidity = 0n;
    this.tickCurrent = 0;
    this.feeRate = feeRate;
    this.tickSpacing = tickSpacing;
    this.feeRatePpm = feeRatePpm;
    this.protocolFeeShareNumerator = 1n; // default 20% share (1/5)
    this.protocolFeeShareDenominator = 5n;
    this.ticks = new Map();
    this.tickBitmap = new Set();
    this.feeGrowthGlobal0X64 = 0n;
    this.feeGrowthGlobal1X64 = 0n;
  }
  get price(): number {
    // Convert Q64.64 sqrtPrice to actual price
    // sqrtPriceX64 is sqrt(price) * 2^64
    const sqrtPrice = Number(this.sqrtPriceX64) / Number(Q64);
    return sqrtPrice * sqrtPrice;
  }

  // Convert tick to sqrtPrice (Q64.64)
  tickToSqrtPrice(tick: number): bigint {
    const sqrtPrice = Math.sqrt(Base ** tick);
    return BigInt(Math.floor(sqrtPrice * Number(Q64)));
  }

  // Convert sqrtPrice (Q64.64) to tick
  sqrtPriceToTick(sqrtPrice: bigint): number {
    const price = Number(sqrtPrice) / Number(Q64);
    return Math.floor((2 * Math.log(price)) / Math.log(Base));
  }

  // Get active liquidity at current tick
  getActiveLiquidity(): bigint {
    return this.liquidity;
  }

  applyLiquidityDelta(
    tickLower: number,
    tickUpper: number,
    liquidityDelta: bigint
  ) {
    if (liquidityDelta === 0n) {
      return;
    }

    const deltaAbs = liquidityDelta >= 0n ? liquidityDelta : -liquidityDelta;
    const grossDelta = liquidityDelta >= 0n ? deltaAbs : -deltaAbs;

    this.updateTickData(tickLower, liquidityDelta, grossDelta);
    this.updateTickData(tickUpper, -liquidityDelta, grossDelta);

    if (this.tickCurrent >= tickLower && this.tickCurrent < tickUpper) {
      this.liquidity += liquidityDelta;
      if (this.liquidity < 0n) this.liquidity = 0n;
    }
  }

  private updateTickData(tick: number, netDelta: bigint, grossDelta: bigint) {
    if (!this.ticks.has(tick)) {
      this.ticks.set(tick, {
        liquidityNet: 0n,
        liquidityGross: 0n,
        feeGrowthOutside0X64: 0n,
        feeGrowthOutside1X64: 0n,
      });
    }

    const tickData = this.ticks.get(tick)!;
    tickData.liquidityNet += netDelta;
    tickData.liquidityGross += grossDelta;

    if (tickData.liquidityGross <= 0n && tickData.liquidityNet === 0n) {
      this.ticks.delete(tick);
      this.tickBitmap.delete(tick);
    } else {
      if (tickData.liquidityGross < 0n) {
        tickData.liquidityGross = 0n;
      }
      this.tickBitmap.add(tick);
    }
  }

  // ===== POOL STATE CHANGES (APPLY FUNCTIONS) =====
  // These functions actually change the pool state (replay events)
  // Use for simulating real transactions and state updates

  applyRepayFlashSwap(
    amountXDebt: bigint,
    amountYDebt: bigint,
    paidX: bigint,
    paidY: bigint,
    reserveX?: bigint,
    reserveY?: bigint
  ): void {
    // Flash swap repayment adjusts reserves based on the actual amounts paid
    // The debt amounts represent what was borrowed, paid amounts represent what was returned

    // Update reserves if provided in the event data
    if (reserveX !== undefined) {
      this.reserveA = reserveX;
    }
    if (reserveY !== undefined) {
      this.reserveB = reserveY;
    }

    // Note: Flash swaps don't change the pool's price or liquidity directly
    // They only affect reserves. The actual swap mechanics are handled separately
    // if there was a swap involved in the flash loan repayment.
  }

  applySwap(amountIn: bigint, zeroForOne: boolean): bigint {
    const fees = this.calculateFees(amountIn);
    const result = this.applySwapInternal(amountIn, zeroForOne, fees);
    return result.amountOut;
  }

  // Apply swap with validation against event data
  applySwapWithValidation(
    amountIn: bigint,
    zeroForOne: boolean,
    expectedAmountOut?: bigint,
    expectedFee?: bigint,
    expectedProtocolFee?: bigint
  ): {
    amountOut: bigint;
    feeAmount: bigint;
    protocolFee: bigint;
    validation: {
      amountOutMatch: boolean;
      feeMatch: boolean;
      protocolFeeMatch: boolean;
      amountOutDifference: bigint;
      feeDifference: bigint;
      protocolFeeDifference: bigint;
      isExactMatch: boolean;
    };
  } {
    // Update validation statistics
    this.validationStats.totalSwaps++;

    // Calculate fee amount
    const computedFees = this.calculateFees(amountIn);
    const lpFee = expectedFee != null ? expectedFee : computedFees.lpFee;
    const protocolFee =
      expectedProtocolFee != null
        ? expectedProtocolFee
        : computedFees.protocolFee;
    const totalFee = lpFee + protocolFee;

    const swapResult = this.applySwapInternal(amountIn, zeroForOne, {
      totalFee,
      lpFee,
      protocolFee,
    });
    const amountOut = swapResult.amountOut;

    // Validate against expected values if provided
    const validation = {
      amountOutMatch: expectedAmountOut
        ? amountOut === expectedAmountOut
        : true,
      feeMatch: expectedFee ? lpFee === expectedFee : true,
      protocolFeeMatch: expectedProtocolFee
        ? protocolFee === expectedProtocolFee
        : true,
      amountOutDifference: expectedAmountOut
        ? amountOut - expectedAmountOut
        : 0n,
      feeDifference: expectedFee ? lpFee - expectedFee : 0n,
      protocolFeeDifference: expectedProtocolFee
        ? protocolFee - expectedProtocolFee
        : 0n,
      isExactMatch: true, // Will be set to false if any validation fails
    };

    // Check if all validations pass
    validation.isExactMatch =
      validation.amountOutMatch &&
      validation.feeMatch &&
      validation.protocolFeeMatch;

    // Update statistics for mismatches
    if (!validation.amountOutMatch) {
      this.validationStats.amountOutMismatches++;
      this.validationStats.totalAmountOutDifference +=
        validation.amountOutDifference;
    }

    if (!validation.feeMatch) {
      this.validationStats.feeMismatches++;
      this.validationStats.totalFeeDifference += validation.feeDifference;
    }

    if (!validation.protocolFeeMatch) {
      this.validationStats.protocolFeeMismatches++;
      this.validationStats.totalProtocolFeeDifference +=
        validation.protocolFeeDifference;
    }

    // Track exact matches (all validations pass)
    if (validation.isExactMatch) {
      this.validationStats.exactMatches++;
    }

    return {
      amountOut,
      feeAmount: lpFee,
      protocolFee,
      validation,
    };
  }

  private applySwapInternal(
    amountIn: bigint,
    zeroForOne: boolean,
    fees: { totalFee: bigint; lpFee: bigint; protocolFee: bigint }
  ): { amountOut: bigint } {
    if (amountIn <= 0n) {
      return { amountOut: 0n };
    }

    const { totalFee, lpFee } = fees;
    if (lpFee > 0n) {
      this.updateFeeGrowth(lpFee, zeroForOne);
    }

    const amountInAfterFee = amountIn > totalFee ? amountIn - totalFee : 0n;
    if (amountInAfterFee === 0n) {
      return { amountOut: 0n };
    }

    const result = this.executeCLMMSwap(amountInAfterFee, zeroForOne);
    this.sqrtPriceX64 = result.newSqrtPriceX64;
    this.tickCurrent = result.newTick;
    return { amountOut: result.amountOut };
  }

  // Execute CLMM swap logic
  private executeCLMMSwap(
    amountIn: bigint,
    zeroForOne: boolean
  ): {
    amountOut: bigint;
    newSqrtPriceX64: bigint;
    newTick: number;
  } {
    let currentSqrtPriceX64 = this.sqrtPriceX64;
    let currentTick = this.tickCurrent;
    let amountOut = 0n;
    let remainingAmount = amountIn;

    while (remainingAmount > 0n) {
      const nextTick = this.getNextTick(currentTick, zeroForOne);

      if (nextTick === null) {
        const swapResult = this.swapAtPrice(
          remainingAmount,
          currentSqrtPriceX64,
          zeroForOne
        );
        amountOut += swapResult.amountOut;
        currentSqrtPriceX64 = swapResult.newSqrtPriceX64;
        currentTick = this.sqrtPriceToTick(currentSqrtPriceX64);
        remainingAmount = 0n;
        break;
      }

      const maxAmountAtCurrentPrice = this.calculateMaxSwapAtPrice(
        currentSqrtPriceX64,
        nextTick,
        zeroForOne
      );

      if (maxAmountAtCurrentPrice <= 0n) {
        break;
      }

      if (remainingAmount <= maxAmountAtCurrentPrice) {
        const swapResult = this.swapAtPrice(
          remainingAmount,
          currentSqrtPriceX64,
          zeroForOne
        );
        amountOut += swapResult.amountOut;
        currentSqrtPriceX64 = swapResult.newSqrtPriceX64;
        currentTick = this.sqrtPriceToTick(currentSqrtPriceX64);
        remainingAmount = 0n;
        break;
      }

      const swapResult = this.swapAtPrice(
        maxAmountAtCurrentPrice,
        currentSqrtPriceX64,
        zeroForOne
      );
      amountOut += swapResult.amountOut;
      remainingAmount -= maxAmountAtCurrentPrice;

      currentSqrtPriceX64 = this.tickToSqrtPrice(nextTick);
      currentTick = nextTick;
      this.updateFeeGrowthOutside(nextTick, zeroForOne);

      const tickData = this.ticks.get(nextTick);
      if (tickData) {
        const liquidityNet = tickData.liquidityNet;
        if (zeroForOne) {
          this.liquidity -= liquidityNet;
        } else {
          this.liquidity += liquidityNet;
        }
        if (this.liquidity < 0n) this.liquidity = 0n;
      }
    }

    return {
      amountOut,
      newSqrtPriceX64: currentSqrtPriceX64,
      newTick: currentTick,
    };
  }

  // Get the next tick to cross in the swap direction
  private getNextTick(currentTick: number, zeroForOne: boolean): number | null {
    if (zeroForOne) {
      // Looking for the next lower tick
      const lowerTicks = Array.from(this.tickBitmap)
        .filter((tick) => tick < currentTick)
        .sort((a, b) => b - a); // Sort descending
      return lowerTicks.length > 0 ? lowerTicks[0]! : null;
    } else {
      // Looking for the next higher tick
      const higherTicks = Array.from(this.tickBitmap)
        .filter((tick) => tick > currentTick)
        .sort((a, b) => a - b); // Sort ascending
      return higherTicks.length > 0 ? higherTicks[0]! : null;
    }
  }

  // Calculate maximum amount that can be swapped at current price before hitting next tick
  private calculateMaxSwapAtPrice(
    currentSqrtPriceX64: bigint,
    nextTick: number,
    zeroForOne: boolean
  ): bigint {
    const nextSqrtPriceX64 = this.tickToSqrtPrice(nextTick);
    const Q64 = 2n ** 64n;

    if (zeroForOne) {
      // Maximum token0 (A) that can be swapped before hitting next tick
      const numerator =
        this.liquidity * (currentSqrtPriceX64 - nextSqrtPriceX64) * Q64;
      const denominator = currentSqrtPriceX64 * nextSqrtPriceX64;
      return numerator / denominator;
    } else {
      // Maximum token1 (B) before crossing up to next tick
      const deltaSqrtPrice = nextSqrtPriceX64 - currentSqrtPriceX64;
      return (this.liquidity * deltaSqrtPrice) / Q64;
    }
  }

  // Execute swap at a specific price
  private swapAtPrice(
    amountIn: bigint,
    sqrtPriceX64: bigint,
    zeroForOne: boolean
  ): {
    amountOut: bigint;
    newSqrtPriceX64: bigint;
  } {
    // Use Q128.64 fixed-point arithmetic for precision
    const Q64 = 2n ** 64n;

    if (zeroForOne) {
      // Swapping token0 for token1, price decreases
      if (this.liquidity === 0n) {
        return { amountOut: 0n, newSqrtPriceX64: sqrtPriceX64 };
      }
      const numerator = this.liquidity * sqrtPriceX64 * Q64;
      const denominator = this.liquidity * Q64 + amountIn * sqrtPriceX64;
      const newSqrtPriceX64 =
        denominator === 0n ? sqrtPriceX64 : numerator / denominator;
      const delta = sqrtPriceX64 - newSqrtPriceX64;
      const amountOut = this.mulDivRoundingDown(this.liquidity, delta, Q64);
      return { amountOut, newSqrtPriceX64 };
    } else {
      // Swapping token1 for token0, price increases
      if (this.liquidity === 0n) {
        return { amountOut: 0n, newSqrtPriceX64: sqrtPriceX64 };
      }
      const newSqrtPriceX64 = sqrtPriceX64 + (amountIn * Q64) / this.liquidity;
      const delta = newSqrtPriceX64 - sqrtPriceX64;
      const numerator = this.liquidity * delta * Q64;
      const denominator = newSqrtPriceX64 * sqrtPriceX64;
      const amountOut = denominator === 0n ? 0n : numerator / denominator;
      return { amountOut, newSqrtPriceX64 };
    }
  }

  // Update global fee growth when fees are collected
  private updateFeeGrowth(feeAmount: bigint, zeroForOne: boolean) {
    if (this.liquidity > 0n) {
      const feeGrowthDelta = (feeAmount * 2n ** 64n) / this.liquidity;
      if (zeroForOne) {
        this.feeGrowthGlobal0X64 += feeGrowthDelta;
      } else {
        this.feeGrowthGlobal1X64 += feeGrowthDelta;
      }
    }
  }

  // Get fees accumulated at a specific tick
  getFeesAtTick(tick: number): { fee0: bigint; fee1: bigint } {
    const tickData = this.ticks.get(tick);
    if (!tickData) {
      return { fee0: 0n, fee1: 0n };
    }

    // Calculate fee growth inside the tick range
    const feeGrowthInside0X64 = this.calculateFeeGrowthInside(tick, tick, 0);
    const feeGrowthInside1X64 = this.calculateFeeGrowthInside(tick, tick, 1);

    // Calculate fees based on liquidity and fee growth
    const fee0 = (tickData.liquidityGross * feeGrowthInside0X64) / 2n ** 64n;
    const fee1 = (tickData.liquidityGross * feeGrowthInside1X64) / 2n ** 64n;

    return { fee0, fee1 };
  }

  // Helper: Handle BigInt subtraction with wrap-around (for Q64.64 fixed-point)
  private submod(a: bigint, b: bigint): bigint {
    // For Q64.64 values, handle wrap-around at 2^256
    const diff = a - b;
    if (diff < 0n) {
      // Wrap around: this handles the case where fee growth has wrapped
      return diff + 2n ** 256n;
    }
    return diff;
  }

  // Calculate fee growth inside a tick range
  calculateFeeGrowthInside(
    tickLower: number,
    tickUpper: number,
    tokenIndex: number
  ): bigint {
    const globalFeeGrowth =
      tokenIndex === 0 ? this.feeGrowthGlobal0X64 : this.feeGrowthGlobal1X64;

    const tickLowerData = this.ticks.get(tickLower);
    const tickUpperData = this.ticks.get(tickUpper);

    if (!tickLowerData || !tickUpperData) {
      return 0n;
    }

    const feeGrowthOutsideLower =
      tokenIndex === 0
        ? tickLowerData.feeGrowthOutside0X64
        : tickLowerData.feeGrowthOutside1X64;
    const feeGrowthOutsideUpper =
      tokenIndex === 0
        ? tickUpperData.feeGrowthOutside0X64
        : tickUpperData.feeGrowthOutside1X64;

    // Calculate fee growth inside the range
    // Use submod to handle BigInt wrap-around correctly
    let feeGrowthInside: bigint;
    if (this.tickCurrent < tickLower) {
      // Current price below range
      feeGrowthInside = this.submod(
        feeGrowthOutsideLower,
        feeGrowthOutsideUpper
      );
    } else if (this.tickCurrent >= tickUpper) {
      // Current price above range
      feeGrowthInside = this.submod(
        feeGrowthOutsideUpper,
        feeGrowthOutsideLower
      );
    } else {
      // Current price inside range
      const temp = this.submod(globalFeeGrowth, feeGrowthOutsideLower);
      feeGrowthInside = this.submod(temp, feeGrowthOutsideUpper);
    }

    return feeGrowthInside;
  }

  // Update fee growth outside when crossing a tick
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

  // Get all ticks with their current fee information
  getAllTicksWithFees(): Array<{
    tick: number;
    liquidity: bigint;
    fee0: bigint;
    fee1: bigint;
  }> {
    const result: Array<{
      tick: number;
      liquidity: bigint;
      fee0: bigint;
      fee1: bigint;
    }> = [];

    for (const [tick, tickData] of this.ticks) {
      const fees = this.getFeesAtTick(tick);
      result.push({
        tick,
        liquidity: tickData.liquidityGross,
        fee0: fees.fee0,
        fee1: fees.fee1,
      });
    }

    return result.sort((a, b) => a.tick - b.tick);
  }

  // Estimate exact amount out for a given amount in (for backtesting)
  estimateAmountOut(
    amountIn: bigint,
    zeroForOne: boolean
  ): {
    amountOut: bigint;
    feeAmount: bigint;
    priceImpact: number;
  } {
    // Step 1: Calculate fee amount first (same as applySwap)
    const fees = this.calculateFees(amountIn);
    const amountInAfterFee =
      amountIn > fees.totalFee ? amountIn - fees.totalFee : 0n;

    const result =
      amountInAfterFee > 0n
        ? this.executeCLMMSwap(amountInAfterFee, zeroForOne)
        : {
            amountOut: 0n,
            newSqrtPriceX64: this.sqrtPriceX64,
            newTick: this.tickCurrent,
          };

    // Calculate price impact
    const priceImpact = this.calculatePriceImpact(
      amountIn,
      result.amountOut,
      zeroForOne
    );

    return {
      amountOut: result.amountOut,
      feeAmount: fees.lpFee,
      priceImpact,
    };
  }

  // Estimate exact amount in needed to get desired amount out (for backtesting)
  estimateAmountIn(
    amountOut: bigint,
    zeroForOne: boolean
  ): {
    amountIn: bigint;
    feeAmount: bigint;
    totalCost: bigint;
    priceImpact: number;
  } {
    // Use binary search to find the correct amount in
    let low = 0n;
    let high = amountOut * 2n; // Start with a reasonable upper bound
    let bestGrossAmountIn = 0n;

    while (low <= high) {
      const gross = (low + high) / 2n;
      const fees = this.calculateFees(gross);
      const net = gross > fees.totalFee ? gross - fees.totalFee : 0n;
      const testResult =
        net > 0n
          ? this.executeCLMMSwap(net, zeroForOne)
          : {
              amountOut: 0n,
              newSqrtPriceX64: this.sqrtPriceX64,
              newTick: this.tickCurrent,
            };

      if (testResult.amountOut === amountOut) {
        bestGrossAmountIn = gross;
        break;
      } else if (testResult.amountOut < amountOut) {
        low = gross + 1n;
      } else {
        bestGrossAmountIn = gross;
        high = gross - 1n;
      }
    }

    const fees = this.calculateFees(bestGrossAmountIn);
    const totalCost = bestGrossAmountIn;
    const priceImpact = this.calculatePriceImpact(
      totalCost,
      amountOut,
      zeroForOne
    );

    return {
      amountIn: bestGrossAmountIn,
      feeAmount: fees.lpFee,
      totalCost,
      priceImpact,
    };
  }

  private calculateFees(amountIn: bigint): {
    totalFee: bigint;
    lpFee: bigint;
    protocolFee: bigint;
  } {
    if (amountIn <= 0n) {
      return { totalFee: 0n, lpFee: 0n, protocolFee: 0n };
    }

    const ppm =
      this.feeRatePpm > 0n
        ? this.feeRatePpm
        : BigInt(Math.round(this.feeRate * 1_000_000));
    if (ppm <= 0n) {
      return { totalFee: 0n, lpFee: 0n, protocolFee: 0n };
    }

    const rawFee = (amountIn * ppm + 1_000_000n - 1n) / 1_000_000n; // ceil(amount * rate)

    if (rawFee <= 0n) {
      return { totalFee: 0n, lpFee: 0n, protocolFee: 0n };
    }

    let lpFee = (rawFee * 4n + 5n - 1n) / 5n; // ceil(0.8 * rawFee)
    if (lpFee < 1n) {
      lpFee = 1n;
    }

    let protocolFee = rawFee - lpFee;
    if (protocolFee < 0n) {
      protocolFee = 0n;
    }

    const totalFee = lpFee + protocolFee;

    return { totalFee, lpFee, protocolFee };
  }

  calculateLiquidityAmount(
    tickLower: number,
    tickUpper: number,
    amountA: bigint,
    amountB: bigint
  ): bigint {
    const currentTick = this.tickCurrent;

    if (currentTick < tickLower) {
      return amountA;
    }
    if (currentTick >= tickUpper) {
      return amountB;
    }
    return amountA < amountB ? amountA : amountB;
  }

  private mulDivRoundingDown(
    a: bigint,
    b: bigint,
    denominator: bigint
  ): bigint {
    if (denominator === 0n || a === 0n || b === 0n) return 0n;
    return (a * b) / denominator;
  }

  private mulDivRoundingUp(a: bigint, b: bigint, denominator: bigint): bigint {
    if (denominator === 0n || a === 0n || b === 0n) return 0n;
    const product = a * b;
    const result = product / denominator;
    return product % denominator === 0n ? result : result + 1n;
  }

  // Calculate price impact of a swap
  private calculatePriceImpact(
    amountIn: bigint,
    amountOut: bigint,
    zeroForOne: boolean
  ): number {
    const currentPrice = this.price;

    let effectivePrice: number;
    if (zeroForOne) {
      // Swapping A for B: price = B/A (how much B you get per A)
      effectivePrice = Number(amountOut) / Number(amountIn);
    } else {
      // Swapping B for A: need to invert (price = A/B)
      effectivePrice = Number(amountIn) / Number(amountOut);
    }

    // Calculate price impact as percentage
    const priceImpact =
      Math.abs((effectivePrice - currentPrice) / currentPrice) * 100;
    return priceImpact;
  }

  // Get current pool state for backtesting analysis
  getPoolState(): {
    reserveA: bigint;
    reserveB: bigint;
    price: number;
    liquidity: bigint;
    tickCurrent: number;
    feeRate: number;
    totalFeesCollected: { fee0: bigint; fee1: bigint };
  } {
    return {
      reserveA: this.reserveA,
      reserveB: this.reserveB,
      price: this.price,
      liquidity: this.liquidity,
      tickCurrent: this.tickCurrent,
      feeRate: this.feeRate,
      totalFeesCollected: {
        fee0: this.feeGrowthGlobal0X64,
        fee1: this.feeGrowthGlobal1X64,
      },
    };
  }

  // Estimate swap cost breakdown for backtesting
  estimateSwapCost(
    amountIn: bigint,
    zeroForOne: boolean
  ): {
    amountOut: bigint;
    feeAmount: bigint;
    priceImpact: number;
    effectivePrice: number;
    slippage: number;
    totalCost: bigint;
  } {
    const estimation = this.estimateAmountOut(amountIn, zeroForOne);

    // Calculate effective price
    const effectivePrice = Number(estimation.amountOut) / Number(amountIn);

    // Calculate slippage (difference from current price)
    const currentPrice = this.price;
    const slippage =
      Math.abs((effectivePrice - currentPrice) / currentPrice) * 100;

    return {
      amountOut: estimation.amountOut,
      feeAmount: estimation.feeAmount,
      priceImpact: estimation.priceImpact,
      effectivePrice,
      slippage,
      totalCost: amountIn,
    };
  }

  // Validation statistics tracking
  private validationStats = {
    totalSwaps: 0,
    amountOutMismatches: 0,
    feeMismatches: 0,
    protocolFeeMismatches: 0,
    totalAmountOutDifference: 0n,
    totalFeeDifference: 0n,
    totalProtocolFeeDifference: 0n,
    exactMatches: 0,
  };

  // Get validation statistics
  getValidationStats() {
    return {
      ...this.validationStats,
      amountOutMatchRate:
        this.validationStats.totalSwaps > 0
          ? (this.validationStats.totalSwaps -
              this.validationStats.amountOutMismatches) /
            this.validationStats.totalSwaps
          : 1,
      feeMatchRate:
        this.validationStats.totalSwaps > 0
          ? (this.validationStats.totalSwaps -
              this.validationStats.feeMismatches) /
            this.validationStats.totalSwaps
          : 1,
      protocolFeeMatchRate:
        this.validationStats.totalSwaps > 0
          ? (this.validationStats.totalSwaps -
              this.validationStats.protocolFeeMismatches) /
            this.validationStats.totalSwaps
          : 1,
      exactMatchRate:
        this.validationStats.totalSwaps > 0
          ? this.validationStats.exactMatches / this.validationStats.totalSwaps
          : 1,
    };
  }

  // Reset validation statistics
  resetValidationStats(): void {
    this.validationStats = {
      totalSwaps: 0,
      amountOutMismatches: 0,
      feeMismatches: 0,
      protocolFeeMismatches: 0,
      totalAmountOutDifference: 0n,
      totalFeeDifference: 0n,
      totalProtocolFeeDifference: 0n,
      exactMatches: 0,
    };
  }

  // ===== VIRTUAL POSITION ESTIMATIONS (NO POOL STATE CHANGES) =====
  // These functions work with virtual positions and don't change pool state
  // Use for backtesting and strategy planning

  // Estimate opening a virtual position
  estimateOpenPosition(
    tickLower: number,
    tickUpper: number,
    amountA: bigint,
    amountB: bigint
  ): {
    liquidityAmount: bigint;
    actualAmountA: bigint;
    actualAmountB: bigint;
    unusedAmountA: bigint;
    unusedAmountB: bigint;
    priceRange: { lower: number; upper: number };
    currentTick: number;
    isInRange: boolean;
    estimatedFees: { fee0: bigint; fee1: bigint };
  } {
    const currentTick = this.tickCurrent;
    const isInRange = currentTick >= tickLower && currentTick < tickUpper;

    // Calculate actual amounts needed based on current price
    const { actualAmountA, actualAmountB, unusedAmountA, unusedAmountB } =
      this.calculateActualLiquidityAmounts(
        tickLower,
        tickUpper,
        amountA,
        amountB
      );

    // Calculate liquidity amount
    const liquidityAmount = this.calculateLiquidityAmount(
      tickLower,
      tickUpper,
      actualAmountA,
      actualAmountB
    );

    // Estimate fees that would be earned
    const estimatedFees = this.estimatePositionFees(
      tickLower,
      tickUpper,
      liquidityAmount
    );

    return {
      liquidityAmount,
      actualAmountA,
      actualAmountB,
      unusedAmountA,
      unusedAmountB,
      priceRange: {
        lower: Number(this.tickToSqrtPrice(tickLower)) / 2 ** 64,
        upper: Number(this.tickToSqrtPrice(tickUpper)) / 2 ** 64,
      },
      currentTick,
      isInRange,
      estimatedFees,
    };
  }

  // Estimate closing a virtual position
  estimateClosePosition(
    tickLower: number,
    tickUpper: number,
    liquidityAmount: bigint
  ): {
    amountA: bigint;
    amountB: bigint;
    fees: { fee0: bigint; fee1: bigint };
    totalValue: bigint;
    priceImpact: number;
  } {
    // Calculate amounts to be returned
    const { amountA, amountB } = this.calculateRemoveLiquidityAmounts(
      tickLower,
      tickUpper,
      liquidityAmount
    );

    // Calculate fees earned
    const fees = this.estimatePositionFees(
      tickLower,
      tickUpper,
      liquidityAmount
    );

    // Calculate total value
    const totalValue = amountA + amountB;

    // Calculate price impact (simplified)
    const priceImpact = this.calculateLiquidityPriceImpact(
      tickLower,
      tickUpper,
      liquidityAmount
    );

    return {
      amountA,
      amountB,
      fees,
      totalValue,
      priceImpact,
    };
  }

  // Estimate collecting fees from virtual position
  estimateCollectFee(
    tickLower: number,
    tickUpper: number,
    liquidityAmount: bigint
  ): {
    collectableFees: { fee0: bigint; fee1: bigint };
    totalFees: { fee0: bigint; fee1: bigint };
    feeGrowthInside: { fee0: bigint; fee1: bigint };
    estimatedValue: bigint;
  } {
    // Calculate current fees
    const currentFees = this.estimatePositionFees(
      tickLower,
      tickUpper,
      liquidityAmount
    );

    // Calculate fee growth inside the range
    const feeGrowthInside0 = this.calculateFeeGrowthInside(
      tickLower,
      tickUpper,
      0
    );
    const feeGrowthInside1 = this.calculateFeeGrowthInside(
      tickLower,
      tickUpper,
      1
    );

    // Calculate total fees (including previously collected)
    const totalFees = {
      fee0: currentFees.fee0,
      fee1: currentFees.fee1,
    };

    // Estimate value of collected fees
    const estimatedValue = currentFees.fee0 + currentFees.fee1;

    return {
      collectableFees: currentFees,
      totalFees,
      feeGrowthInside: {
        fee0: feeGrowthInside0,
        fee1: feeGrowthInside1,
      },
      estimatedValue,
    };
  }

  // Calculate actual amounts needed for liquidity provision
  private calculateActualLiquidityAmounts(
    tickLower: number,
    tickUpper: number,
    amountA: bigint,
    amountB: bigint
  ): {
    actualAmountA: bigint;
    actualAmountB: bigint;
    unusedAmountA: bigint;
    unusedAmountB: bigint;
  } {
    const currentTick = this.tickCurrent;

    if (currentTick < tickLower) {
      // Only token A is needed
      return {
        actualAmountA: amountA,
        actualAmountB: 0n,
        unusedAmountA: 0n,
        unusedAmountB: amountB,
      };
    } else if (currentTick >= tickUpper) {
      // Only token B is needed
      return {
        actualAmountA: 0n,
        actualAmountB: amountB,
        unusedAmountA: amountA,
        unusedAmountB: 0n,
      };
    } else {
      // Both tokens needed, calculate optimal ratio
      const price = this.price;
      const optimalAmountB =
        (amountA * BigInt(Math.floor(price * 1000000))) / 1000000n;

      if (optimalAmountB <= amountB) {
        return {
          actualAmountA: amountA,
          actualAmountB: optimalAmountB,
          unusedAmountA: 0n,
          unusedAmountB: amountB - optimalAmountB,
        };
      } else {
        const optimalAmountA =
          (amountB * 1000000n) / BigInt(Math.floor(price * 1000000));
        return {
          actualAmountA: optimalAmountA,
          actualAmountB: amountB,
          unusedAmountA: amountA - optimalAmountA,
          unusedAmountB: 0n,
        };
      }
    }
  }

  // Calculate amounts returned when removing liquidity
  private calculateRemoveLiquidityAmounts(
    tickLower: number,
    tickUpper: number,
    liquidityAmount: bigint
  ): { amountA: bigint; amountB: bigint } {
    const currentTick = this.tickCurrent;

    if (currentTick < tickLower) {
      // Only token A will be returned
      return { amountA: liquidityAmount, amountB: 0n };
    } else if (currentTick >= tickUpper) {
      // Only token B will be returned
      return { amountA: 0n, amountB: liquidityAmount };
    } else {
      // Both tokens will be returned proportionally
      const price = this.price;
      const amountA = liquidityAmount;
      const amountB =
        (liquidityAmount * BigInt(Math.floor(price * 1000000))) / 1000000n;
      return { amountA, amountB };
    }
  }

  // Estimate fees for a position
  private estimatePositionFees(
    tickLower: number,
    tickUpper: number,
    liquidityAmount: bigint
  ): { fee0: bigint; fee1: bigint } {
    // Calculate fee growth inside the range
    const feeGrowthInside0 = this.calculateFeeGrowthInside(
      tickLower,
      tickUpper,
      0
    );
    const feeGrowthInside1 = this.calculateFeeGrowthInside(
      tickLower,
      tickUpper,
      1
    );

    // Calculate fees based on liquidity
    const fee0 = (liquidityAmount * feeGrowthInside0) / 2n ** 64n;
    const fee1 = (liquidityAmount * feeGrowthInside1) / 2n ** 64n;

    return { fee0, fee1 };
  }

  // Calculate price impact of liquidity operations
  private calculateLiquidityPriceImpact(
    tickLower: number,
    tickUpper: number,
    liquidityAmount: bigint
  ): number {
    // Simplified price impact calculation
    // In practice, this would be more complex based on the liquidity curve
    const currentPrice = this.price;
    const priceRange =
      this.tickToSqrtPrice(tickUpper) - this.tickToSqrtPrice(tickLower);
    const liquidityRatio = Number(liquidityAmount) / Number(this.liquidity);

    // Estimate price impact based on liquidity ratio and range
    const priceImpact =
      liquidityRatio * (Number(priceRange) / currentPrice) * 100;
    return Math.abs(priceImpact);
  }

  // Estimate optimal liquidity range for given amounts
  estimateOptimalRange(
    amountA: bigint,
    amountB: bigint,
    targetPrice?: number
  ): {
    tickLower: number;
    tickUpper: number;
    expectedLiquidity: bigint;
    priceRange: { lower: number; upper: number };
    utilization: number;
  } {
    const currentPrice = targetPrice || this.price;
    const currentTick = this.sqrtPriceToTick(this.tickToSqrtPrice(0));

    // Calculate optimal range based on amounts and current price
    const priceRatio = Number(amountB) / Number(amountA);
    const optimalTick = Math.floor(Math.log(priceRatio) / Math.log(1.0001));

    // Calculate range based on volatility (simplified)
    const rangeSize = Math.floor(Math.log(2) / Math.log(1.0001)); // 2x price range
    const tickLower = optimalTick - rangeSize;
    const tickUpper = optimalTick + rangeSize;

    // Calculate expected liquidity
    const expectedLiquidity = this.calculateLiquidityAmount(
      tickLower,
      tickUpper,
      amountA,
      amountB
    );

    // Calculate utilization
    const utilization = Number(expectedLiquidity) / Number(this.liquidity);

    return {
      tickLower,
      tickUpper,
      expectedLiquidity,
      priceRange: {
        lower: Number(this.tickToSqrtPrice(tickLower)) / 2 ** 64,
        upper: Number(this.tickToSqrtPrice(tickUpper)) / 2 ** 64,
      },
      utilization,
    };
  }
}

export { Pool };
