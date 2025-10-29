import type { BacktestStrategy, StrategyContext } from "../backtest_engine";
import { VirtualPositionManager } from "../virtual_position_mgr";
import { Pool } from "../pool";
import {
  ThreeBandPydiumStrategy,
  type ThreeBandPydiumConfig,
} from "./three_band_pydium";
import * as fs from "fs";

type EnvConfig = {
  initialAmountA: bigint;
  initialAmountB: bigint;
  position1WidthTicks: number;
  position2WidthTicks: number;
  position3WidthTicks: number;
  position1AllocPct: number;
  position2AllocPct: number;
  position3AllocPct: number;
  cooldownMs: number;
  maxRebalancePer24Hours: number;
  actionCostTokenA: number;
  actionCostTokenB: number;
  maxSwapSlippageBps: number;
  bootstrapMaxSwapSlippageBps: number;
  bootstrapAttempts: number;
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
    initialAmountA: toBigInt(process.env.PYDIUM_INITIAL_A, 0n),
    initialAmountB: toBigInt(process.env.PYDIUM_INITIAL_B, 10_000_000_000n), // 10B default
    position1WidthTicks: toNumber(process.env.PYDIUM_POS1_WIDTH, 2),
    position2WidthTicks: toNumber(process.env.PYDIUM_POS2_WIDTH, 6),
    position3WidthTicks: toNumber(process.env.PYDIUM_POS3_WIDTH, 8),
    position1AllocPct: toNumber(process.env.PYDIUM_POS1_ALLOC, 30),
    position2AllocPct: toNumber(process.env.PYDIUM_POS2_ALLOC, 30),
    position3AllocPct: toNumber(process.env.PYDIUM_POS3_ALLOC, 40),
    cooldownMs: toNumber(process.env.PYDIUM_COOLDOWN_MS, 5 * 60_000), // 5 minutes
    maxRebalancePer24Hours: toNumber(process.env.PYDIUM_MAX_REBALANCE_24H, 48),
    actionCostTokenA: toNumber(process.env.PYDIUM_ACTION_COST_A, 0),
    actionCostTokenB: toNumber(process.env.PYDIUM_ACTION_COST_B, 5000),
    maxSwapSlippageBps: toNumber(process.env.PYDIUM_MAX_SLIPPAGE_BPS, 50),
    bootstrapMaxSwapSlippageBps: toNumber(
      process.env.PYDIUM_BOOTSTRAP_SLIPPAGE_BPS,
      200
    ),
    bootstrapAttempts: toNumber(process.env.PYDIUM_BOOTSTRAP_ATTEMPTS, 3),
  };
}

export function strategyFactory(pool: Pool): BacktestStrategy {
  const env = readEnvConfig();
  const manager = new VirtualPositionManager(pool);
  manager.setInitialBalances(env.initialAmountA, env.initialAmountB);

  // CSV file writer for separate output
  const csvFilePath = `pydium_backtest_${Date.now()}.csv`;
  let csvInitialized = false;

  const config: Partial<ThreeBandPydiumConfig> = {
    position1WidthTicks: env.position1WidthTicks,
    position2WidthTicks: env.position2WidthTicks,
    position3WidthTicks: env.position3WidthTicks,
    position1AllocPct: env.position1AllocPct,
    position2AllocPct: env.position2AllocPct,
    position3AllocPct: env.position3AllocPct,
    cooldownMs: env.cooldownMs,
    maxRebalancePer24Hours: env.maxRebalancePer24Hours,
    actionCostTokenA: env.actionCostTokenA,
    actionCostTokenB: env.actionCostTokenB,
    maxSwapSlippageBps: env.maxSwapSlippageBps,
    bootstrapMaxSwapSlippageBps: env.bootstrapMaxSwapSlippageBps,
    bootstrapAttempts: env.bootstrapAttempts,
  };

  const strategy = new ThreeBandPydiumStrategy(manager, pool, config);
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

    // Calculate total value and breakdown
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

    // Calculate fees
    const feesOwedA = totals.feesOwed0 ?? 0n;
    const feesOwedB = totals.feesOwed1 ?? 0n;
    const feesCollectedA = totals.collectedFees0 ?? 0n;
    const feesCollectedB = totals.collectedFees1 ?? 0n;
    const totalFeesA = feesOwedA + feesCollectedA;
    const totalFeesB = feesOwedB + feesCollectedB;

    // Main log line
    ctx.logger?.log?.(
      `[pydium] ${new Date(
        ctx.timestamp
      ).toISOString()} action=${action} msg=${message} | tick=${tick} price=${price.toFixed(
        6
      )} | value=${totalValue.toFixed(0)} (A:${valueA.toFixed(
        0
      )} B:${valueB.toFixed(0)}) | positions=${
        positions.length
      } inRange=${inRangeCount} | fees=(A:${totalFeesA} B:${totalFeesB})`
    );

    // Log position details on create/rebalance actions
    if (action === "create" || action === "rebalance") {
      for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        if (pos) {
          const status =
            tick >= pos.tickLower && tick < pos.tickUpper
              ? "IN-RANGE"
              : tick < pos.tickLower
              ? "BELOW"
              : "ABOVE";
          const posType = i === 0 ? "NARROW" : i === 1 ? "MEDIUM" : "WIDE";
          ctx.logger?.log?.(
            `[pydium]   ${posType} Position ${i + 1}: [${pos.tickLower},${
              pos.tickUpper
            }] ${status} liquidity=${pos.liquidity}`
          );
        }
      }
    }

    // CSV format for analysis (3 positions)
    const csvParts: string[] = [
      new Date(ctx.timestamp).toISOString(),
      tick.toString(),
      price.toFixed(6),
      action,
      inRangeCount.toString(),
    ];

    // Add position data (3 positions)
    const maxPositions = 3;
    for (let i = 0; i < maxPositions; i++) {
      if (i < positions.length && positions[i]) {
        const pos = positions[i]!;
        const posInRange =
          tick >= pos.tickLower && tick < pos.tickUpper ? "1" : "0";
        const posFeesA = pos.tokensOwed0.toString();
        const posFeesB = pos.tokensOwed1.toString();

        // Check if position has liquidity
        if (pos.liquidity === 0n) {
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
          // Calculate actual current amounts
          const { currentAmountA, currentAmountB } =
            manager.calculatePositionAmounts(pos.id);

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
      } else {
        // Empty fields for missing positions
        csvParts.push("", "", "", "", "", "", "");
      }
    }

    // Calculate sum of position amounts
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
    const totalCurrentA = sumAmountA + cashA;
    const totalCurrentB = sumAmountB + cashB;

    // Add totals
    csvParts.push(
      totalCurrentA.toString(),
      totalCurrentB.toString(),
      totalFeesA.toString(),
      totalFeesB.toString()
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
      ctx.logger?.log?.(`[pydium] CSV output file: ${csvFilePath}`);
    }

    // Append data row
    fs.appendFileSync(csvFilePath, csvParts.join(",") + "\n");

    // Additional details for rebalance actions
    if (action === "rebalance") {
      const pydiumPositions = strategy.getPositions();
      if (pydiumPositions.length > 0) {
        const narrowPos = pydiumPositions[0];
        if (narrowPos) {
          const timeSinceLastRebalance =
            ctx.timestamp - narrowPos.lastRebalanceTime;
          const rebalanceCount24h = strategy["rebalanceHistory"].filter(
            (ts) => ts > ctx.timestamp - 24 * 60 * 60 * 1000
          ).length;

          ctx.logger?.log?.(
            `[pydium]   → Rebalance stats: timeSince=${Math.floor(
              timeSinceLastRebalance / 1000
            )}s, count24h=${rebalanceCount24h}/${env.maxRebalancePer24Hours}`
          );
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
    id: "three-band-pydium",
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
        `[pydium] before closing: positions=${beforeTotals.positions} amountA=${beforeTotals.amountA} amountB=${beforeTotals.amountB} cashA=${beforeTotals.cashAmountA} cashB=${beforeTotals.cashAmountB}`
      );
      ctx.logger?.log?.(
        `[pydium] initial investment: initialA=${beforeTotals.initialAmountA} initialB=${beforeTotals.initialAmountB}`
      );

      // Close all positions
      const pydiumPositions = strategy.getPositions();
      for (const pos of pydiumPositions) {
        manager.removePosition(pos.id, {
          tokenA: env.actionCostTokenA > 0 ? env.actionCostTokenA : undefined,
          tokenB: env.actionCostTokenB > 0 ? env.actionCostTokenB : undefined,
        });
      }

      // Log final state
      const totals = manager.getTotals();
      ctx.logger?.log?.(`[pydium] FINISH TOTALS:`);
      ctx.logger?.log?.(
        `  Positions: amountA=${totals.amountA} amountB=${totals.amountB}`
      );
      ctx.logger?.log?.(
        `  Cash: cashA=${totals.cashAmountA} cashB=${totals.cashAmountB}`
      );
      ctx.logger?.log?.(
        `  Fees: feesOwed0=${totals.feesOwed0} feesOwed1=${totals.feesOwed1}`
      );
      ctx.logger?.log?.(
        `  Collected: collected0=${totals.collectedFees0} collected1=${totals.collectedFees1}`
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
