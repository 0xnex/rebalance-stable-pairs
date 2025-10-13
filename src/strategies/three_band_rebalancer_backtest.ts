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
  };
}

export function strategyFactory(pool: Pool): BacktestStrategy {
  const env = readEnvConfig();
  const manager = new VirtualPositionManager(pool);
  manager.setInitialBalances(env.initialAmountA, env.initialAmountB);

  // CSV file writer for separate output
  const csvFilePath = `three_band_backtest_${Date.now()}.csv`;
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

    // Calculate fees (keep raw values, no decimal conversion)
    // feesOwed = uncollected fees, collectedFees = already collected
    const feesOwedA = Number(totals.feesOwed0);
    const feesOwedB = Number(totals.feesOwed1);
    const feesCollectedA = Number(totals.collectedFees0);
    const feesCollectedB = Number(totals.collectedFees1);
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
      )} B:${valueB.toFixed(0)}) | positions=${positions.length
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
            `[three-band]   Position ${i + 1}: [${pos.tickLower},${pos.tickUpper
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
        const posFeesA = Number(pos.tokensOwed0);
        const posFeesB = Number(pos.tokensOwed1);

        // Check if position has liquidity
        if (pos.liquidity === 0n) {
          // Position has no liquidity - treat as empty
          ctx.logger?.log?.(
            `[three-band-warn] Position ${i + 1} [${pos.tickLower},${pos.tickUpper
            }] has ZERO liquidity - failed to open or was fully closed`
          );
          csvParts.push(
            pos.tickLower.toString(),
            pos.tickUpper.toString(),
            "0",
            "0",
            "0",
            "0",
            "0"
          );
        } else {
          // Calculate actual current amounts based on position's liquidity and current price
          const { currentAmountA, currentAmountB } =
            manager.calculatePositionAmounts(pos.id);

          // Debug: log if position has zero amounts but has liquidity
          if (
            currentAmountA === 0n &&
            currentAmountB === 0n &&
            pos.liquidity > 0n
          ) {
            ctx.logger?.log?.(
              `[three-band-debug] Position ${i + 1} (${pos.id}) has liquidity ${pos.liquidity
              } but shows 0,0 amounts. Range:[${pos.tickLower},${pos.tickUpper
              }] CurrentTick:${tick}`
            );
          }

          // Debug: detect and log unrealistic spikes
          const MAX_REASONABLE_AMOUNT = 1e15; // 1 quadrillion (very large but reasonable)
          const MAX_REASONABLE_FEES = 1e12;   // 1 trillion

          // Safe BigInt to Number conversion with overflow protection
          const safeBigIntToNumber = (value: bigint): number => {
            try {
              const num = Number(value);
              // Check for overflow (Number.MAX_SAFE_INTEGER = 2^53 - 1)
              if (!Number.isFinite(num) || num > Number.MAX_SAFE_INTEGER) {
                return Number.MAX_SAFE_INTEGER;
              }
              return num;
            } catch {
              return Number.MAX_SAFE_INTEGER;
            }
          };

          const amountANum = safeBigIntToNumber(currentAmountA);
          const amountBNum = safeBigIntToNumber(currentAmountB);

          if (amountANum > MAX_REASONABLE_AMOUNT || amountBNum > MAX_REASONABLE_AMOUNT ||
            posFeesA > MAX_REASONABLE_FEES || posFeesB > MAX_REASONABLE_FEES) {
            ctx.logger?.log?.(
              `[three-band-SPIKE] Position ${i + 1} UNREALISTIC VALUES: amountA=${currentAmountA} amountB=${currentAmountB} feesA=${posFeesA} feesB=${posFeesB} liquidity=${pos.liquidity} tick=${tick} range=[${pos.tickLower},${pos.tickUpper}]`
            );

            // Cap the values to prevent CSV corruption
            const cappedAmountA = amountANum > MAX_REASONABLE_AMOUNT ? pos.amountA : currentAmountA;
            const cappedAmountB = amountBNum > MAX_REASONABLE_AMOUNT ? pos.amountB : currentAmountB;
            const cappedFeesA = posFeesA > MAX_REASONABLE_FEES ? 0 : posFeesA;
            const cappedFeesB = posFeesB > MAX_REASONABLE_FEES ? 0 : posFeesB;

            csvParts.push(
              pos.tickLower.toString(),
              pos.tickUpper.toString(),
              cappedAmountA.toString(),
              cappedAmountB.toString(),
              cappedFeesA.toString(),
              cappedFeesB.toString(),
              posInRange
            );
          } else {
            csvParts.push(
              pos.tickLower.toString(),
              pos.tickUpper.toString(),
              currentAmountA.toString(),
              currentAmountB.toString(),
              posFeesA.toString(),
              posFeesB.toString(),
              posInRange
            );
          }
        }
      } else {
        // Empty fields for missing positions
        csvParts.push("", "", "", "", "", "", "");
      }
    }

    // Calculate sum of position amounts (actual current amounts) with safety checks
    let sumAmountA = 0n;
    let sumAmountB = 0n;
    const MAX_TOTAL_AMOUNT = 2n ** 96n; // Very large but reasonable upper bound

    for (const pos of positions) {
      try {
        const { currentAmountA, currentAmountB } =
          manager.calculatePositionAmounts(pos.id);

        // Safety check to prevent overflow accumulation
        if (currentAmountA < MAX_TOTAL_AMOUNT && currentAmountB < MAX_TOTAL_AMOUNT) {
          sumAmountA += currentAmountA;
          sumAmountB += currentAmountB;
        } else {
          // Fallback to stored amounts for unrealistic calculated amounts
          sumAmountA += pos.amountA;
          sumAmountB += pos.amountB;
          ctx.logger?.log?.(
            `[three-band-SPIKE] Position ${pos.id} calculated amounts too large, using stored amounts`
          );
        }
      } catch (error) {
        // Fallback to stored amounts if calculation fails
        sumAmountA += pos.amountA;
        sumAmountB += pos.amountB;
        ctx.logger?.log?.(
          `[three-band-error] Failed to calculate amounts for position ${pos.id}, using stored amounts`
        );
      }
    }

    // Add cash balances to get true total
    const cashA = totals.cashAmountA ?? 0n;
    const cashB = totals.cashAmountB ?? 0n;
    const totalCurrentA = sumAmountA + cashA;
    const totalCurrentB = sumAmountB + cashB;

    // Safety check for total values before CSV output
    const MAX_REASONABLE_TOTAL = 1e18; // 1 quintillion (very large but reasonable)

    // Safe BigInt to Number conversion for totals
    const safeBigIntToNumber = (value: bigint): number => {
      try {
        const num = Number(value);
        if (!Number.isFinite(num) || num > Number.MAX_SAFE_INTEGER) {
          return Number.MAX_SAFE_INTEGER;
        }
        return num;
      } catch {
        return Number.MAX_SAFE_INTEGER;
      }
    };

    const totalANum = safeBigIntToNumber(totalCurrentA);
    const totalBNum = safeBigIntToNumber(totalCurrentB);

    let finalTotalA = totalCurrentA;
    let finalTotalB = totalCurrentB;

    if (totalANum > MAX_REASONABLE_TOTAL || totalBNum > MAX_REASONABLE_TOTAL) {
      ctx.logger?.log?.(
        `[three-band-SPIKE] UNREALISTIC TOTALS: totalA=${totalCurrentA} totalB=${totalCurrentB} - using fallback`
      );
      // Fallback to sum of stored amounts + cash
      finalTotalA = positions.reduce((sum, pos) => sum + pos.amountA, 0n) + cashA;
      finalTotalB = positions.reduce((sum, pos) => sum + pos.amountB, 0n) + cashB;
    }

    // Add totals (sum of actual position amounts + cash)
    csvParts.push(
      finalTotalA.toString(),
      finalTotalB.toString(),
      totalFeesA.toString(),
      totalFeesB.toString()
    );

    // Debug: verify totals are reasonable
    ctx.logger?.log?.(
      `[three-band-debug] Sum of positions: A=${sumAmountA} B=${sumAmountB}, Cash: A=${cashA} B=${cashB}, Total: A=${totalCurrentA} B=${totalCurrentB}`
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
        "pos1_amount_b",
        "pos1_fee_a",
        "pos1_fee_b",
        "pos1_in_range",
        "pos2_tick_lower",
        "pos2_tick_upper",
        "pos2_amount_a",
        "pos2_amount_b",
        "pos2_fee_a",
        "pos2_fee_b",
        "pos2_in_range",
        "pos3_tick_lower",
        "pos3_tick_upper",
        "pos3_amount_a",
        "pos3_amount_b",
        "pos3_fee_a",
        "pos3_fee_b",
        "pos3_in_range",
        "total_amount_a",
        "total_amount_b",
        "total_fee_a",
        "total_fee_b",
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

            // Show profit check details (keep all raw values)
            const rotationCost = (config.actionCostTokenB ?? 0) * 2;
            const minProfitB = config.minRotationProfitTokenB ?? 0;

            const estimatedFeeValueB = totalFeesB + totalFeesA * price;
            const netProfit = estimatedFeeValueB - rotationCost;
            const profitOk = netProfit >= minProfitB ? "✓" : "✗";

            ctx.logger?.log?.(
              `[three-band]   → Conditions: minOutOfRangeMs=${(
                config.minOutOfRangeMs! / 1000
              ).toFixed(0)}s minProfitB=${minProfitB} rotationTickThreshold=${config.rotationTickThreshold
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
      for (const segment of strategy.getSegments()) {
        manager.removePosition(segment.id, {
          tokenA: env.actionCostTokenA > 0 ? env.actionCostTokenA : undefined,
          tokenB: env.actionCostTokenB > 0 ? env.actionCostTokenB : undefined,
        });
      }
      const totals = manager.getTotals();
      ctx.logger?.log?.(
        `[three-band] finish totals amountA=${totals.amountA.toString()} amountB=${totals.amountB.toString()} feesOwed0=${totals.feesOwed0.toString()} feesOwed1=${totals.feesOwed1.toString()} collected0=${totals.collectedFees0.toString()} collected1=${totals.collectedFees1.toString()} costA=${totals.totalCostTokenA.toFixed(
          4
        )} costB=${totals.totalCostTokenB.toFixed(4)}`
      );
    },
  };
}

export default strategyFactory;
