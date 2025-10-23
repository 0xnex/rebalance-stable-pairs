import type {
  IPool,
  ISlippageProvider,
  SwapEvent,
  OptimizationResult,
} from "./types";

export class SimplePool implements IPool {
  private token0: string;
  private token1: string;
  private decimals0: number;
  private decimals1: number;
  private tickSpacing: number;
  private feeTier: number;
  private sqrtPriceX64: bigint = 0n;
  private tick: number = 0;
  private reserve0: bigint = 0n;
  private reserve1: bigint = 0n;
  private liquidity: bigint = 0n;
  private totalFee0: bigint = 0n;
  private totalFee1: bigint = 0n;

  private slipMrg: ISlippageProvider;

  private static readonly Q64 = 1n << 64n;

  private static readonly PPM = 1000000;

  constructor(
    token0: string,
    token1: string,
    decimals0: number,
    decimals1: number,
    feeTier: number, // PPM based
    tickSpacing: number,
    slipMrg: ISlippageProvider
  ) {
    this.token0 = token0;
    this.token1 = token1;
    this.tickSpacing = tickSpacing;
    this.feeTier = feeTier;
    this.decimals0 = decimals0;
    this.decimals1 = decimals1;
    this.slipMrg = slipMrg;
  }

  swap(
    amountIn: bigint,
    xForY: boolean
  ): { amountOut: bigint; fee: bigint; slippage: bigint } {
    if (amountIn <= 0n) {
      return { amountOut: 0n, fee: 0n, slippage: 0n };
    }

    // Calculate fee: fee = amountIn * feeTier / 1000000
    const fee = (amountIn * BigInt(this.feeTier)) / BigInt(SimplePool.PPM);
    const amountInAfterFee = amountIn - fee;

    if (amountInAfterFee <= 0n) {
      return { amountOut: 0n, fee, slippage: 0n };
    }

    // Get current price
    const currentPrice = this.price();

    // Calculate base amountOut using price
    let amountOut: bigint;
    if (xForY) {
      // Selling token0 for token1: amountOut = amountIn * price
      amountOut = BigInt(Math.floor(Number(amountInAfterFee) * currentPrice));
    } else {
      // Selling token1 for token0: amountOut = amountIn / price
      amountOut = BigInt(Math.floor(Number(amountInAfterFee) / currentPrice));
    }

    // Apply slippage: get slippage percentage and reduce amountOut
    const slippagePct = this.slipMrg.getSlippagePct(
      amountIn,
      xForY,
      currentPrice
    );
    const slippageAmount = BigInt(Math.floor(Number(amountOut) * slippagePct));
    amountOut = amountOut - slippageAmount;

    // Ensure amountOut is not negative
    if (amountOut < 0n) {
      amountOut = 0n;
    }

    return {
      amountOut,
      fee,
      slippage: slippageAmount,
    };
  }

  /**
   * 简化版本：通过最多一次 swap 获得最大流动性
   * 返回详细的资金使用和剩余情况
   */
  maxL(
    amount0: bigint,
    amount1: bigint,
    lower: number,
    upper: number
  ): {
    // Swap 信息
    needSwap: boolean;
    swapDirection: "0to1" | "1to0" | null;
    swapAmount: bigint;
    swapReceived: bigint;
    swapFee: bigint;
    swapSlippage: bigint;

    // 最终资金状态
    finalAmount0: bigint;
    finalAmount1: bigint;

    // 流动性使用情况
    liquidityAmount0Used: bigint;
    liquidityAmount1Used: bigint;
    liquidityL: bigint;

    // 剩余资金
    remainingAmount0: bigint;
    remainingAmount1: bigint;

    // 改善情况
    originalL: bigint;
    optimizedL: bigint;
    improvementPct: number;
  } {
    const currentPrice = this.price();

    // 计算原始状态的 maxL
    const originalMaxL = this.maxL(amount0, amount1, lower, upper);

    // 尝试三种策略：不 swap、swap token0→token1、swap token1→token0
    const strategies = [
      // 策略 1: 不进行 swap
      {
        needSwap: false,
        swapDirection: null as "0to1" | "1to0" | null,
        swapAmount: 0n,
        swapReceived: 0n,
        swapFee: 0n,
        swapSlippage: 0n,
        finalAmount0: amount0,
        finalAmount1: amount1,
      },
    ];

    // 策略 2: 尝试 swap 一部分 token0 → token1
    if (amount0 > 0n) {
      // 尝试不同比例的 swap (10%, 25%, 50%, 75%, 90%)
      const swapRatios = [0.1, 0.25, 0.5, 0.75, 0.9];

      for (const ratio of swapRatios) {
        const swapAmount = BigInt(Math.floor(Number(amount0) * ratio));
        if (swapAmount > 0n) {
          const swapResult = this.swap(swapAmount, true);
          strategies.push({
            needSwap: true,
            swapDirection: "0to1" as const,
            swapAmount,
            swapReceived: swapResult.amountOut,
            swapFee: swapResult.fee,
            swapSlippage: swapResult.slippage,
            finalAmount0: amount0 - swapAmount,
            finalAmount1: amount1 + swapResult.amountOut,
          });
        }
      }
    }

    // 策略 3: 尝试 swap 一部分 token1 → token0
    if (amount1 > 0n) {
      const swapRatios = [0.1, 0.25, 0.5, 0.75, 0.9];

      for (const ratio of swapRatios) {
        const swapAmount = BigInt(Math.floor(Number(amount1) * ratio));
        if (swapAmount > 0n) {
          const swapResult = this.swap(swapAmount, false);
          strategies.push({
            needSwap: true,
            swapDirection: "1to0" as const,
            swapAmount,
            swapReceived: swapResult.amountOut,
            swapFee: swapResult.fee,
            swapSlippage: swapResult.slippage,
            finalAmount0: amount0 + swapResult.amountOut,
            finalAmount1: amount1 - swapAmount,
          });
        }
      }
    }

    // 评估每个策略，选择最优的
    let bestStrategy = strategies[0]!; // 确保不为 undefined
    let bestMaxL = originalMaxL;

    for (const strategy of strategies) {
      const maxLResult = this.maxL(
        strategy.finalAmount0,
        strategy.finalAmount1,
        lower,
        upper
      );

      // 如果需要 swap，检查成本效益
      if (strategy.needSwap) {
        const swapCost =
          Number(strategy.swapFee) + Number(strategy.swapSlippage);
        const swapCostRatio = swapCost / Number(strategy.swapAmount);
        const liquidityImprovement = Number(maxLResult.L) - Number(bestMaxL.L);
        const improvementRatio = liquidityImprovement / Number(bestMaxL.L);

        // 只有当改善幅度超过成本的2倍时才采用
        if (improvementRatio > swapCostRatio * 2) {
          bestStrategy = strategy;
          bestMaxL = maxLResult;
        }
      } else {
        // 无 swap 策略总是可以考虑
        if (maxLResult.L > bestMaxL.L) {
          bestStrategy = strategy;
          bestMaxL = maxLResult;
        }
      }
    }

    // 计算最终结果
    const finalMaxL = this.maxL(
      bestStrategy.finalAmount0,
      bestStrategy.finalAmount1,
      lower,
      upper
    );
    const improvementPct =
      Number(finalMaxL.L) > Number(originalMaxL.L)
        ? ((Number(finalMaxL.L) - Number(originalMaxL.L)) /
            Number(originalMaxL.L)) *
          100
        : 0;

    return {
      // Swap 信息
      needSwap: bestStrategy.needSwap,
      swapDirection: bestStrategy.swapDirection,
      swapAmount: bestStrategy.swapAmount,
      swapReceived: bestStrategy.swapReceived,
      swapFee: bestStrategy.swapFee,
      swapSlippage: bestStrategy.swapSlippage,

      // 最终资金状态
      finalAmount0: bestStrategy.finalAmount0,
      finalAmount1: bestStrategy.finalAmount1,

      // 流动性使用情况
      liquidityAmount0Used: finalMaxL.amount0Used,
      liquidityAmount1Used: finalMaxL.amount1Used,
      liquidityL: finalMaxL.L,

      // 剩余资金
      remainingAmount0: bestStrategy.finalAmount0 - finalMaxL.amount0Used,
      remainingAmount1: bestStrategy.finalAmount1 - finalMaxL.amount1Used,

      // 改善情况
      originalL: originalMaxL.L,
      optimizedL: finalMaxL.L,
      improvementPct,
    };
  }

  /**
   * 通过一次 swap 优化代币比例，使流动性 L 最大化
   * @param amount0 当前持有的 token0 数量
   * @param amount1 当前持有的 token1 数量
   * @param lower 价格下限
   * @param upper 价格上限
   * @returns 优化结果，包含建议的 swap 操作和最终的 maxL 结果
   */
  optimizeForMaxL(
    amount0: bigint,
    amount1: bigint,
    lower: number,
    upper: number
  ): OptimizationResult {
    // 使用简化版本的逻辑
    const simpleResult = this.optimizeForMaxLSimple(
      amount0,
      amount1,
      lower,
      upper
    );

    // 转换为原始接口格式
    return {
      needSwap: simpleResult.needSwap,
      swapDirection: simpleResult.swapDirection,
      swapAmount: simpleResult.swapAmount,
      swapResult: simpleResult.needSwap
        ? {
            amountOut: simpleResult.swapReceived,
            fee: simpleResult.swapFee,
            slippage: simpleResult.swapSlippage,
          }
        : undefined,
      finalAmount0: simpleResult.finalAmount0,
      finalAmount1: simpleResult.finalAmount1,
      maxLResult: {
        L: simpleResult.liquidityL,
        amount0Used: simpleResult.liquidityAmount0Used,
        amount1Used: simpleResult.liquidityAmount1Used,
        fee0: 0n, // 简化版本不单独计算这些
        fee1: 0n,
        slip0: 0n,
        slip1: 0n,
      },
      improvement: {
        originalL: simpleResult.originalL,
        optimizedL: simpleResult.optimizedL,
        improvementPct: simpleResult.improvementPct,
      },
    };
  }

  onSwapEvent(evt: SwapEvent): void {
    if (evt.zeroForOne) {
      this.totalFee0 += evt.feeAmount;
    } else {
      this.totalFee1 += evt.feeAmount;
    }
    this.liquidity += evt.liquidity;
    this.sqrtPriceX64 = evt.newSqrtPrice;
    this.tick = evt.tick;
    this.reserve0 = evt.reserveA;
    this.reserve1 = evt.reserveB;
  }

  price(): number {
    const sqrtPrice = Number(this.sqrtPriceX64) / Number(SimplePool.Q64);
    return sqrtPrice * sqrtPrice;
  }
}
