import type { BacktestStrategy, StrategyContext } from "../backtest_engine";
import { VirtualPositionManager } from "../virtual_position_mgr";
import { Pool } from "../pool";
import {
  ThreeBandRebalancerStrategy,
  type ThreeBandRebalancerConfig,
} from "./three_band_rebalancer_strategy";
import * as fs from "fs";

type EnvConfig = {
  initialAmountA: bigint;
  initialAmountB: bigint;
  segmentRangePercent: number;
  segmentCount: number;
  checkIntervalMs: number;
  maxSwapSlippageBps: number;
  bootstrapMaxSwapSlippageBps: number;
  bootstrapAttempts: number;
  actionCostTokenA: number;
  actionCostTokenB: number;
  fastSegmentCount: number;
  fastIntervalMs: number;
  slowIntervalMs: number;
  minSegmentDwellMs: number;
  minOutOfRangeMs: number;
  rotationTickThreshold: number;
  minRotationProfitTokenB: number;
  enableDynamicAllocation: boolean;
  enableAdaptiveBandWidth: boolean;
  enablePredictiveRotation: boolean;
  enableFeeCompounding: boolean;
  enableSmartSlippage: boolean;
  feeCompoundingThresholdPercent: number;
  volatilityWindowMs: number;
  momentumWindowSize: number;
  activeBandWeightPercent: number;
  tokenADecimals: number;
  tokenBDecimals: number;
  position1AllocationPercent: number;
  position2AllocationPercent: number;
  position3AllocationPercent: number;
};

function readEnvConfig(): EnvConfig {
  const toBigInt = (value: string | undefined, fallback: bigint) => {
    if (!value) return fallback;
    try {
      return BigInt(value);
    } catch {
      return fallback;
    }
  };

  const toNumber = (value: string | undefined, fallback: number) => {
    if (!value) return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  };

  return {
    initialAmountA: toBigInt(process.env.THREEBAND_INITIAL_A, 0n),
    initialAmountB: toBigInt(process.env.THREEBAND_INITIAL_B, 10_000_000_000n), // 10B default in raw units
    segmentRangePercent: toNumber(process.env.THREEBAND_RANGE_PERCENT, 0.001),
    segmentCount: toNumber(process.env.THREEBAND_SEGMENT_COUNT, 3),
    checkIntervalMs: toNumber(process.env.THREEBAND_CHECK_INTERVAL_MS, 60_000),
    maxSwapSlippageBps: toNumber(process.env.THREEBAND_MAX_SLIPPAGE_BPS, 50),
    bootstrapMaxSwapSlippageBps: toNumber(
      process.env.THREEBAND_BOOTSTRAP_SLIPPAGE_BPS,
      200
    ),
    bootstrapAttempts: toNumber(process.env.THREEBAND_BOOTSTRAP_ATTEMPTS, 3),
    actionCostTokenA: toNumber(process.env.THREEBAND_ACTION_COST_A, 0),
    actionCostTokenB: toNumber(process.env.THREEBAND_ACTION_COST_B, 5000), // Raw units (not decimal)
    fastSegmentCount: toNumber(process.env.THREEBAND_FAST_COUNT, 3), // All bands are fast
    fastIntervalMs: toNumber(process.env.THREEBAND_FAST_INTERVAL_MS, 10_000),
    slowIntervalMs: toNumber(
      process.env.THREEBAND_SLOW_INTERVAL_MS,
      toNumber(process.env.THREEBAND_FAST_INTERVAL_MS, 10_000) // Default to fast interval
    ),
    minSegmentDwellMs: toNumber(
      process.env.THREEBAND_MIN_DWELL_MS,
      2 * 60 * 1000
    ),
    minOutOfRangeMs: toNumber(process.env.THREEBAND_MIN_OUT_MS, 2 * 60 * 1000),
    rotationTickThreshold: toNumber(
      process.env.THREEBAND_ROTATION_TICK_THRESHOLD,
      0
    ),
    minRotationProfitTokenB: toNumber(process.env.THREEBAND_MIN_PROFIT_B, 0), // Raw units (not decimal)

    // Enhanced features - ALL DISABLED for simplicity
    enableDynamicAllocation: false,
    enableAdaptiveBandWidth: false,
    enablePredictiveRotation: false,
    enableFeeCompounding: false,
    enableSmartSlippage: false,
    feeCompoundingThresholdPercent: 1.0,
    volatilityWindowMs: 600_000,
    momentumWindowSize: 5,
    activeBandWeightPercent: 33.33, // Not used when enableDynamicAllocation=false
    tokenADecimals: toNumber(process.env.TOKEN_A_DECIMALS, 9),
    tokenBDecimals: toNumber(process.env.TOKEN_B_DECIMALS, 9),
    position1AllocationPercent: toNumber(
      process.env.THREEBAND_POS1_ALLOCATION,
      33.33
    ),
    position2AllocationPercent: toNumber(
      process.env.THREEBAND_POS2_ALLOCATION,
      33.33
    ),
    position3AllocationPercent: toNumber(
      process.env.THREEBAND_POS3_ALLOCATION,
      33.33
    ),
  };
}

export function strategyFactory(pool: Pool): BacktestStrategy {
  const env = readEnvConfig();
  const manager = new VirtualPositionManager(pool);
  manager.setInitialBalances(env.initialAmountA, env.initialAmountB);

  // CSV file writer for separate output
  const tradingPair = process.env.TRADING_PAIR || "SUI/USDC";
  const pairForFilename = tradingPair.replace("/", "_");
  const csvFilePath = `three_band_backtest_${pairForFilename}_${Date.now()}.csv`;
  let csvInitialized = false;

  const config: Partial<ThreeBandRebalancerConfig> = {
    segmentCount: env.segmentCount,
    segmentRangePercent: env.segmentRangePercent,
    maxSwapSlippageBps: env.maxSwapSlippageBps,
    bootstrapMaxSwapSlippageBps: env.bootstrapMaxSwapSlippageBps,
    bootstrapAttempts: env.bootstrapAttempts,
    actionCostTokenA: env.actionCostTokenA,
    actionCostTokenB: env.actionCostTokenB,
    fastSegmentCount: env.fastSegmentCount,
    fastIntervalMs: env.fastIntervalMs,
    slowIntervalMs: env.slowIntervalMs,
    minSegmentDwellMs: env.minSegmentDwellMs,
    minOutOfRangeMs: env.minOutOfRangeMs,
    rotationTickThreshold: env.rotationTickThreshold,
    minRotationProfitTokenB: env.minRotationProfitTokenB,
    enableDynamicAllocation: env.enableDynamicAllocation,
    enableAdaptiveBandWidth: env.enableAdaptiveBandWidth,
    enablePredictiveRotation: env.enablePredictiveRotation,
    enableFeeCompounding: env.enableFeeCompounding,
    enableSmartSlippage: env.enableSmartSlippage,
    feeCompoundingThresholdPercent: env.feeCompoundingThresholdPercent,
    volatilityWindowMs: env.volatilityWindowMs,
    momentumWindowSize: env.momentumWindowSize,
    activeBandWeightPercent: env.activeBandWeightPercent,
  };

  const strategy = new ThreeBandRebalancerStrategy(manager, pool, config);
  let lastTimestamp = -1;
  let lastLogKey: string | null = null;

  // Track accumulated fees per position across rebalances
  const accumulatedFeesA: Record<number, bigint> = {};
  const accumulatedFeesB: Record<number, bigint> = {};
  // Track previous fees to detect when fees are collected/reset
  const previousFeesA: Record<number, bigint> = {};
  const previousFeesB: Record<number, bigint> = {};

  // Helper function to format raw amount to decimal string
  const formatAmount = (
    rawAmount: bigint | string,
    decimals: number
  ): string => {
    try {
      const raw = typeof rawAmount === "string" ? BigInt(rawAmount) : rawAmount;
      const divisor = BigInt(10 ** decimals);
      const integerPart = raw / divisor;
      const remainder = raw % divisor;
      const fractionalPart = remainder.toString().padStart(decimals, "0");
      return `${integerPart}.${fractionalPart}`;
    } catch {
      return "0";
    }
  };

  const log = (ctx: StrategyContext, action: string, message: string) => {
    const key = `${action}:${message}`;
    if (lastLogKey === key) return;
    lastLogKey = key;

    // Get current state for detailed logging
    const tick = pool.tickCurrent;
    const price = pool.price;
    const totals = manager.getTotals();
    const positions = manager.getAllPositions();

    // Calculate total value and breakdown (keep raw values)
    const amountA = Number(totals.amountA);
    const amountB = Number(totals.amountB);
    const valueA = amountA * price;
    const valueB = amountB;
    const totalValue = valueA + valueB;

    // Count in-range positions
    let inRangeCount = 0;
    for (const pos of positions) {
      if (tick >= pos.tickLower && tick < pos.tickUpper) {
        inRangeCount++;
      }
    }

    // Calculate fees (keep as BigInt to avoid overflow)
    // feesOwed = uncollected fees, collectedFees = already collected
    const feesOwedA = totals.feesOwed0 ?? 0n;
    const feesOwedB = totals.feesOwed1 ?? 0n;
    const feesCollectedA = totals.collectedFees0 ?? 0n;
    const feesCollectedB = totals.collectedFees1 ?? 0n;
    const totalFeesA = feesOwedA + feesCollectedA;
    const totalFeesB = feesOwedB + feesCollectedB;

    // Main log line with detailed context (all raw values)
    ctx.logger?.log?.(
      `[three-band] ${new Date(
        ctx.timestamp
      ).toISOString()} action=${action} msg=${message} | tick=${tick} price=${price.toFixed(
        6
      )} | value=${totalValue.toFixed(0)} (A:${valueA.toFixed(
        0
      )} B:${valueB.toFixed(0)}) | positions=${
        positions.length
      } inRange=${inRangeCount} | fees=(A:${totalFeesA} B:${totalFeesB})`
    );

    // Log liquidity distribution on create action
    if (action === "create") {
      for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        if (pos) {
          const status =
            tick >= pos.tickLower && tick < pos.tickUpper
              ? "IN-RANGE"
              : tick < pos.tickLower
              ? "BELOW"
              : "ABOVE";
          ctx.logger?.log?.(
            `[three-band]   Position ${i + 1}: [${pos.tickLower},${
              pos.tickUpper
            }] ${status} liquidity=${pos.liquidity}`
          );
        }
      }
    }

    // CSV format for Excel analysis (3 positions)
    const csvParts: string[] = [
      new Date(ctx.timestamp).toISOString(),
      tick.toString(),
      price.toFixed(6),
      action,
      inRangeCount.toString(),
    ];

    // Add position data (3 positions for three-band strategy)
    const maxPositions = 3;
    for (let i = 0; i < maxPositions; i++) {
      if (i < positions.length && positions[i]) {
        const pos = positions[i]!;
        const posInRange =
          tick >= pos.tickLower && tick < pos.tickUpper ? "1" : "0";
        // Use tokensOwed which is updated by updateAllPositionFees() for accurate uncollected fees
        const posFeesA = pos.tokensOwed0.toString();
        const posFeesB = pos.tokensOwed1.toString();
        const allocation =
          i === 0
            ? env.position1AllocationPercent
            : i === 1
            ? env.position2AllocationPercent
            : env.position3AllocationPercent;

        // Check if position has liquidity
        if (pos.liquidity === 0n) {
          // Position has no liquidity - treat as empty
          ctx.logger?.log?.(
            `[three-band-warn] Position ${i + 1} [${pos.tickLower},${
              pos.tickUpper
            }] has ZERO liquidity - failed to open or was fully closed`
          );
          csvParts.push(
            pos.tickLower.toString(),
            pos.tickUpper.toString(),
            "0", // Raw amount A
            "0", // Decimal amount A
            "0", // Raw amount B
            "0", // Decimal amount B
            "0", // Raw fee A
            "0", // Decimal fee A
            "0", // Total fee A
            "0", // Raw fee B
            "0", // Decimal fee B
            "0", // Total fee B
            "0", // In range
            allocation.toString()
          );
        } else {
          // Calculate actual current amounts based on position's liquidity and current price
          const { currentAmountA, currentAmountB } =
            manager.calculatePositionAmounts(pos.id);

          // Convert raw amounts to decimal format using helper function
          const decimalAmountA = formatAmount(
            currentAmountA,
            env.tokenADecimals
          );
          const decimalAmountB = formatAmount(
            currentAmountB,
            env.tokenBDecimals
          );

          // Track accumulated fees across rebalances
          const currentFeesA = BigInt(posFeesA);
          const currentFeesB = BigInt(posFeesB);

          // Initialize accumulated fees if not exists
          if (accumulatedFeesA[i] === undefined) {
            accumulatedFeesA[i] = 0n;
            previousFeesA[i] = 0n;
          }
          if (accumulatedFeesB[i] === undefined) {
            accumulatedFeesB[i] = 0n;
            previousFeesB[i] = 0n;
          }

          // Detect if fees were collected (current < previous) or position was rebalanced
          // In both cases, add previous fees to accumulated before reset
          const prevA = previousFeesA[i]!;
          const prevB = previousFeesB[i]!;

          if (currentFeesA < prevA) {
            accumulatedFeesA[i]! += prevA;
          }
          if (currentFeesB < prevB) {
            accumulatedFeesB[i]! += prevB;
          }

          // Update previous fees for next comparison
          previousFeesA[i] = currentFeesA;
          previousFeesB[i] = currentFeesB;

          // Calculate total fees (accumulated + current)
          const totalAccumulatedFeesA = accumulatedFeesA[i]! + currentFeesA;
          const totalAccumulatedFeesB = accumulatedFeesB[i]! + currentFeesB;

          const decimalFeesA = formatAmount(currentFeesA, env.tokenADecimals);
          const decimalFeesB = formatAmount(currentFeesB, env.tokenBDecimals);
          const decimalTotalFeesA = formatAmount(
            totalAccumulatedFeesA,
            env.tokenADecimals
          );
          const decimalTotalFeesB = formatAmount(
            totalAccumulatedFeesB,
            env.tokenBDecimals
          );

          csvParts.push(
            pos.tickLower.toString(),
            pos.tickUpper.toString(),
            currentAmountA.toString(), // Raw amount
            decimalAmountA, // Decimal amount
            currentAmountB.toString(), // Raw amount
            decimalAmountB, // Decimal amount
            currentFeesA.toString(), // Raw fee
            decimalFeesA, // Decimal fee
            decimalTotalFeesA,
            currentFeesB.toString(), // Raw fee
            decimalFeesB, // Decimal fee
            decimalTotalFeesB,
            posInRange,
            allocation.toString()
          );
        }
      } else {
        // Empty fields for missing positions
        csvParts.push("", "", "", "", "", "", "", "", "", "", "", "", "", "");
      }
    }

    // Calculate sum of position amounts (actual current amounts)
    let sumAmountA = 0n;
    let sumAmountB = 0n;
    for (const pos of positions) {
      const { currentAmountA, currentAmountB } =
        manager.calculatePositionAmounts(pos.id);
      sumAmountA += currentAmountA;
      sumAmountB += currentAmountB;
    }

    // Add cash balances to get true total
    const cashA = totals.cashAmountA ?? 0n;
    const cashB = totals.cashAmountB ?? 0n;
    const totalCurrentARaw = sumAmountA + cashA;
    const totalCurrentBRaw = sumAmountB + cashB;
    const totalCurrentA = formatAmount(totalCurrentARaw, env.tokenADecimals);
    const totalCurrentB = formatAmount(totalCurrentBRaw, env.tokenBDecimals);
    const totalFeesARaw = totalFeesA;
    const totalFeesBRaw = totalFeesB;
    const totalFeesADecimal = formatAmount(totalFeesARaw, env.tokenADecimals);
    const totalFeesBDecimal = formatAmount(totalFeesBRaw, env.tokenBDecimals);
    const totalFeeDecimal =
      Number(totalFeesADecimal) * price + Number(totalFeesBDecimal);
    const totalTokenDecimal =
      Number(totalCurrentA) * price + Number(totalCurrentB);
    const totalValueDecimal = totalFeeDecimal + totalTokenDecimal;

    // Add totals (sum of actual position amounts + cash)
    csvParts.push(
      totalCurrentARaw.toString(), // Raw total amount A
      totalCurrentA, // Decimal total amount A
      totalCurrentBRaw.toString(), // Raw total amount B
      totalCurrentB, // Decimal total amount B
      totalFeesARaw.toString(), // Raw total fee A
      totalFeesADecimal, // Decimal total fee A
      totalFeesBRaw.toString(), // Raw total fee B
      totalFeesBDecimal, // Decimal total fee B
      totalFeeDecimal.toString(),
      totalTokenDecimal.toString(),
      totalValueDecimal.toString()
    );

    // Write CSV to separate file
    if (!csvInitialized) {
      // Write header
      const csvHeader = [
        "timestamp",
        "tick",
        "price",
        "action",
        "in_range_count",
        "pos1_tick_lower",
        "pos1_tick_upper",
        "pos1_amount_a",
        "pos1_amount_a_decimal",
        "pos1_amount_b",
        "pos1_amount_b_decimal",
        "pos1_fee_a",
        "pos1_fee_a_decimal",
        "pos1_total_fee_a",
        "pos1_fee_b",
        "pos1_fee_b_decimal",
        "pos1_total_fee_b",
        "pos1_in_range",
        "pos1_allocation_percent",
        "pos2_tick_lower",
        "pos2_tick_upper",
        "pos2_amount_a",
        "pos2_amount_a_decimal",
        "pos2_amount_b",
        "pos2_amount_b_decimal",
        "pos2_fee_a",
        "pos2_fee_a_decimal",
        "pos2_total_fee_a",
        "pos2_fee_b",
        "pos2_fee_b_decimal",
        "pos2_total_fee_b",
        "pos2_in_range",
        "pos2_allocation_percent",
        "pos3_tick_lower",
        "pos3_tick_upper",
        "pos3_amount_a",
        "pos3_amount_a_decimal",
        "pos3_amount_b",
        "pos3_amount_b_decimal",
        "pos3_fee_a",
        "pos3_fee_a_decimal",
        "pos3_total_fee_a",
        "pos3_fee_b",
        "pos3_fee_b_decimal",
        "pos3_total_fee_b",
        "pos3_in_range",
        "pos3_allocation_percent",
        "total_amount_a",
        "total_amount_a_decimal",
        "total_amount_b",
        "total_amount_b_decimal",
        "total_fee_a",
        "total_fee_a_decimal",
        "total_fee_b",
        "total_fee_b_decimal",
        "total_fee",
        "total_token",
        "total_value",
      ];
      fs.writeFileSync(csvFilePath, csvHeader.join(",") + "\n");
      csvInitialized = true;
      ctx.logger?.log?.(`[three-band] CSV output file: ${csvFilePath}`);
    }

    // Append data row
    fs.appendFileSync(csvFilePath, csvParts.join(",") + "\n");

    // Additional details for position ranges when action is wait or rebalance
    if (action === "wait" || action === "rebalance") {
      const segments = strategy.getSegments();
      if (segments.length > 0) {
        const firstSeg = segments[0];
        const lastSeg = segments[segments.length - 1];

        if (firstSeg && lastSeg) {
          let rangeStatus = "IN RANGE ✓";
          if (tick < firstSeg.tickLower) {
            rangeStatus = "BELOW RANGE ⬇️";
          } else if (tick >= lastSeg.tickUpper) {
            rangeStatus = "ABOVE RANGE ⬆️";
          }

          const lowerDist = tick - firstSeg.tickLower;
          const upperDist = lastSeg.tickUpper - tick;

          ctx.logger?.log?.(
            `[three-band]   → Range: [${firstSeg.tickLower}, ${lastSeg.tickUpper}] | Status: ${rangeStatus} | Distance: lower=${lowerDist}ticks upper=${upperDist}ticks`
          );

          // Show segment dwell times and conditions for wait/rotation actions
          if (message.includes("rotating") || message.includes("Waiting")) {
            const now = ctx.timestamp;
            const direction = message.includes("up") ? "up" : "down";
            const candidateSeg = direction === "up" ? firstSeg : lastSeg;
            const dwellTime = (now - candidateSeg.lastMoved) / 1000;
            const minDwell = config.minSegmentDwellMs! / 1000;
            const dwellOk = dwellTime >= minDwell ? "✓" : "✗";

            ctx.logger?.log?.(
              `[three-band]   → Rebalance Direction: ${direction} | Segment Dwell: ${dwellTime.toFixed(
                1
              )}s / ${minDwell.toFixed(1)}s ${dwellOk}`
            );

            // Show profit check details (convert fees to numbers for calculation)
            const rotationCost = (config.actionCostTokenB ?? 0) * 2;
            const minProfitB = config.minRotationProfitTokenB ?? 0;

            const estimatedFeeValueB =
              Number(totalFeesB) + Number(totalFeesA) * price;
            const netProfit = estimatedFeeValueB - rotationCost;
            const profitOk = netProfit >= minProfitB ? "✓" : "✗";

            ctx.logger?.log?.(
              `[three-band]   → Conditions: minOutOfRangeMs=${(
                config.minOutOfRangeMs! / 1000
              ).toFixed(0)}s minProfitB=${minProfitB} rotationTickThreshold=${
                config.rotationTickThreshold
              }ticks`
            );

            ctx.logger?.log?.(
              `[three-band]   → Profit Check: fees=${estimatedFeeValueB.toFixed(
                0
              )} cost=${rotationCost} net=${netProfit.toFixed(0)} ${profitOk}`
            );
          }
        }
      }
    }
  };

  const runOnce = (ctx: StrategyContext) => {
    if (ctx.timestamp === lastTimestamp) {
      return;
    }
    lastTimestamp = ctx.timestamp;
    manager.updateAllPositionFees();
    strategy.setCurrentTime(ctx.timestamp);
    const outcome = strategy.execute();
    if (outcome.action !== "none") {
      log(ctx, outcome.action, outcome.message);
    }
  };

  return {
    id: "three-band-rebalancer",
    manager,
    async onInit(ctx) {
      manager.updateAllPositionFees();
      strategy.setCurrentTime(ctx.timestamp);
      const result = strategy.initialize();
      log(ctx, result.action, result.message);
    },
    async onTick(ctx) {
      runOnce(ctx);
    },
    async onEvent(ctx) {
      runOnce(ctx);
    },
    async onFinish(ctx) {
      manager.updateAllPositionFees();
      strategy.setCurrentTime(ctx.timestamp);

      // Log state before closing positions
      const beforeTotals = manager.getTotals();
      ctx.logger?.log?.(
        `[three-band] before closing: positions=${beforeTotals.positions} amountA=${beforeTotals.amountA} amountB=${beforeTotals.amountB} cashA=${beforeTotals.cashAmountA} cashB=${beforeTotals.cashAmountB}`
      );
      ctx.logger?.log?.(
        `[three-band] initial investment: initialA=${beforeTotals.initialAmountA} initialB=${beforeTotals.initialAmountB}`
      );

      // Close all positions
      for (const segment of strategy.getSegments()) {
        manager.removePosition(segment.id, {
          tokenA: env.actionCostTokenA > 0 ? env.actionCostTokenA : undefined,
          tokenB: env.actionCostTokenB > 0 ? env.actionCostTokenB : undefined,
        });
      }

      // Log final state after closing positions
      const totals = manager.getTotals();
      ctx.logger?.log?.(`[three-band] FINISH TOTALS:`);
      ctx.logger?.log?.(
        `  Positions (in open positions): amountA=${totals.amountA} amountB=${totals.amountB}`
      );
      ctx.logger?.log?.(
        `  Cash (free balance): cashA=${totals.cashAmountA} cashB=${totals.cashAmountB}`
      );
      ctx.logger?.log?.(
        `  Fees Owed: feesOwed0=${totals.feesOwed0} feesOwed1=${totals.feesOwed1}`
      );
      ctx.logger?.log?.(
        `  Fees Collected: collected0=${totals.collectedFees0} collected1=${totals.collectedFees1}`
      );
      ctx.logger?.log?.(
        `  Costs: costA=${totals.totalCostTokenA.toFixed(
          4
        )} costB=${totals.totalCostTokenB.toFixed(4)}`
      );
      ctx.logger?.log?.(
        `  TOTAL VALUE: ${
          Number(totals.cashAmountA) +
          Number(totals.amountA) +
          Number(totals.collectedFees0) +
          Number(totals.feesOwed0)
        } A + ${
          Number(totals.cashAmountB) +
          Number(totals.amountB) +
          Number(totals.collectedFees1) +
          Number(totals.feesOwed1)
        } B`
      );
    },
  };
}

export default strategyFactory;
