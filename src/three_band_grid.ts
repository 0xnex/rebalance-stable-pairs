import { parseArgs } from "node:util";
import path from "node:path";
import { BacktestEngine } from "./backtest_engine";
import { VirtualPositionManager } from "./virtual_position_mgr";
import {
  ThreeBandRebalancerStrategy,
  type ThreeBandRebalancerConfig,
} from "./strategies/three_band_rebalancer_strategy";
import type { BacktestStrategy } from "./backtest_engine";
import type { Pool } from "./pool";

function splitNumberList(
  value: string | undefined,
  fallback: number[]
): number[] {
  if (!value) return fallback;
  const parts = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part));
  return parts.length > 0 && parts.every((entry) => Number.isFinite(entry))
    ? parts
    : fallback;
}

function splitBigIntList(
  value: string | undefined,
  fallback: bigint[]
): bigint[] {
  if (!value) return fallback;
  const items: bigint[] = [];
  for (const part of value.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    try {
      items.push(BigInt(trimmed));
    } catch (err) {
      return fallback;
    }
  }
  return items.length > 0 ? items : fallback;
}

type GridConfig = {
  poolId: string;
  startTime: number;
  endTime: number;
  stepMs: number;
  dataDir: string;
  segmentCounts: number[];
  rangePercents: number[];
  fastCounts: number[];
  fastIntervals: number[];
  slowIntervals: number[];
  minDwells: number[];
  maxSlippages: number[];
  bootstrapSlippages: number[];
  bootstrapAttempts: number[];
  actionCostsA: number[];
  actionCostsB: number[];
  initialAmountsA: bigint[];
  initialAmountsB: bigint[];
};

function cartesianProduct<T>(lists: T[][]): T[][] {
  return lists.reduce<T[][]>(
    (acc, list) =>
      acc
        .map((entry) => list.map((value) => [...entry, value]))
        .flat(1),
    [[]]
  );
}

async function main() {
  const {
    values: {
      poolId,
      start,
      end,
      step,
      dataDir,
      segmentCounts,
      rangePercents,
      fastCounts,
      fastIntervals,
      slowIntervals,
      minDwells,
      maxSlippages,
      bootstrapSlippages,
      bootstrapAttempts,
      actionCostsA,
      actionCostsB,
      minOutOfRangeMs,
      rotationTickThresholds,
      minProfitBs,
      initialAmountsA,
      initialAmountsB,
    },
  } = parseArgs({
    options: {
      poolId: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      step: { type: "string" },
      dataDir: { type: "string" },
      segmentCounts: { type: "string" },
      rangePercents: { type: "string" },
      fastCounts: { type: "string" },
      fastIntervals: { type: "string" },
      slowIntervals: { type: "string" },
      minDwells: { type: "string" },
      maxSlippages: { type: "string" },
      bootstrapSlippages: { type: "string" },
      bootstrapAttempts: { type: "string" },
      actionCostsA: { type: "string" },
      actionCostsB: { type: "string" },
      minOutOfRangeMs: { type: "string" },
      rotationTickThresholds: { type: "string" },
      minProfitBs: { type: "string" },
      initialAmountsA: { type: "string" },
      initialAmountsB: { type: "string" },
    },
  });

  if (!poolId) throw new Error("--poolId is required");
  if (!start || !end) {
    throw new Error("--start and --end timestamp strings are required");
  }

  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    throw new Error("Invalid start or end timestamp");
  }
  if (endTime <= startTime) {
    throw new Error("End time must be greater than start time");
  }

  const stepMs = step ? Number(step) : 1_000;
  if (!Number.isFinite(stepMs) || stepMs <= 0) {
    throw new Error("--step must be a positive number (milliseconds)");
  }

  const resolvedDataDir = dataDir
    ? path.resolve(process.cwd(), dataDir)
    : path.resolve(__dirname, "../mmt_txs", poolId);

  const gridConfig: GridConfig = {
    poolId,
    startTime,
    endTime,
    stepMs,
    dataDir: resolvedDataDir,
    segmentCounts: splitNumberList(segmentCounts, [3, 5]),
    rangePercents: splitNumberList(rangePercents, [0.001]),
    fastCounts: splitNumberList(fastCounts, [1, 2]),
    fastIntervals: splitNumberList(fastIntervals, [30_000]),
    slowIntervals: splitNumberList(slowIntervals, [60_000, 300_000]),
    minDwells: splitNumberList(minDwells, [0, 120_000]),
    maxSlippages: splitNumberList(maxSlippages, [10]),
    bootstrapSlippages: splitNumberList(bootstrapSlippages, [200]),
    bootstrapAttempts: splitNumberList(bootstrapAttempts, [3]),
    actionCostsA: splitNumberList(actionCostsA, [0]),
    actionCostsB: splitNumberList(actionCostsB, [0.02]),
    minOutOfRangeMs: splitNumberList(minOutOfRangeMs, [120_000]),
    rotationTickThresholds: splitNumberList(rotationTickThresholds, [0]),
    minProfitBs: splitNumberList(minProfitBs, [0.05]),
    initialAmountsA: splitBigIntList(initialAmountsA, [5_000n]),
    initialAmountsB: splitBigIntList(initialAmountsB, [5_000n]),
  };

  const combos = cartesianProduct([
    gridConfig.segmentCounts,
    gridConfig.rangePercents,
    gridConfig.fastCounts,
    gridConfig.fastIntervals,
    gridConfig.slowIntervals,
    gridConfig.minDwells,
    gridConfig.maxSlippages,
    gridConfig.bootstrapSlippages,
    gridConfig.bootstrapAttempts,
    gridConfig.actionCostsA,
    gridConfig.actionCostsB,
    gridConfig.minOutOfRangeMs,
    gridConfig.rotationTickThresholds,
    gridConfig.minProfitBs,
    gridConfig.initialAmountsA,
    gridConfig.initialAmountsB,
  ]);

  console.log(
    `Running ${combos.length} combinations for pool ${gridConfig.poolId}`
  );

  const summary: Array<{
    config: Partial<ThreeBandRebalancerConfig> & {
      initialAmountA: bigint;
      initialAmountB: bigint;
    };
    absoluteReturn: number;
    returnPct: number;
    feesA: number;
    feesB: number;
    costB: number;
  }> = [];

  for (let index = 0; index < combos.length; index++) {
    const [
      segmentCount,
      rangePercent,
      fastCount,
      fastInterval,
      slowInterval,
      minDwell,
      maxSlippage,
      bootstrapSlippage,
      bootstrapAttempt,
      actionCostA,
      actionCostB,
      minOutMs,
      rotationThreshold,
      minProfitB,
      initialA,
      initialB,
    ] = combos[index] as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      bigint,
      bigint
    ];

    const config: Partial<ThreeBandRebalancerConfig> & {
      initialAmountA: bigint;
      initialAmountB: bigint;
    } = {
      segmentCount,
      segmentRangePercent: rangePercent,
      fastSegmentCount: fastCount,
      fastIntervalMs: fastInterval,
      slowIntervalMs: slowInterval,
      minSegmentDwellMs: minDwell,
      maxSwapSlippageBps: maxSlippage,
      bootstrapMaxSwapSlippageBps: bootstrapSlippage,
      bootstrapAttempts: bootstrapAttempt,
      actionCostTokenA: actionCostA,
      actionCostTokenB: actionCostB,
      minOutOfRangeMs: minOutMs,
      rotationTickThreshold: rotationThreshold,
      minRotationProfitTokenB: minProfitB,
      initialAmountA: initialA,
      initialAmountB: initialB,
    };

    console.log(
      `\n[${index + 1}/${combos.length}] Running grid point:`,
      {
        ...config,
        initialAmountA: config.initialAmountA.toString(),
        initialAmountB: config.initialAmountB.toString(),
      }
    );

    const engine = new BacktestEngine({
      poolId: gridConfig.poolId,
      startTime: gridConfig.startTime,
      endTime: gridConfig.endTime,
      stepMs: gridConfig.stepMs,
      dataDir: gridConfig.dataDir,
      logger: undefined,
      strategyFactory(pool) {
        return createStrategy(pool, config);
      },
    });

    try {
      const report = await engine.run();
      const totals = report.totals;
      summary.push({
        config,
        absoluteReturn: report.performance.absoluteReturn,
        returnPct: report.performance.returnPct,
        feesA: Number(totals.collectedFees0),
        feesB: Number(totals.collectedFees1),
        costB: totals.totalCostTokenB,
      });

      console.log(
        `  -> returnPct=${report.performance.returnPct.toFixed(4)}% ` +
          `feesA=${totals.collectedFees0} feesB=${totals.collectedFees1} costB=${totals.totalCostTokenB}`
      );
    } catch (err) {
      console.error(`  -> run failed: ${(err as Error).message}`);
    }
  }

  if (summary.length === 0) {
    console.log("\nNo successful runs recorded.");
    return;
  }

  summary.sort((a, b) => b.returnPct - a.returnPct);

  console.log("\nTop configurations by returnPct:");
  for (const entry of summary.slice(0, 10)) {
    console.log(
      `returnPct=${entry.returnPct.toFixed(4)}% feesA=${entry.feesA} feesB=${entry.feesB} costB=${entry.costB} config=${formatConfig(entry.config)}`
    );
  }
}

function formatConfig(
  config: Partial<ThreeBandRebalancerConfig> & {
    initialAmountA: bigint;
    initialAmountB: bigint;
  }
): string {
  const printable = {
    ...config,
    initialAmountA: config.initialAmountA.toString(),
    initialAmountB: config.initialAmountB.toString(),
  };
  return JSON.stringify(printable);
}

function createStrategy(
  pool: Pool,
  config: Partial<ThreeBandRebalancerConfig> & {
    initialAmountA: bigint;
    initialAmountB: bigint;
  }
): BacktestStrategy {
  const manager = new VirtualPositionManager(pool);
  manager.setInitialBalances(config.initialAmountA, config.initialAmountB);

  const strategy = new ThreeBandRebalancerStrategy(manager, pool, config);
  let lastTimestamp = -1;

  return {
    id: "three-band-grid",
    manager,
    async onInit(ctx) {
      manager.updateAllPositionFees();
      strategy.setCurrentTime(ctx.timestamp);
      strategy.initialize();
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
          tokenA:
            config.actionCostTokenA && config.actionCostTokenA > 0
              ? config.actionCostTokenA
              : undefined,
          tokenB:
            config.actionCostTokenB && config.actionCostTokenB > 0
              ? config.actionCostTokenB
              : undefined,
        });
      }
    },
  };

  function runOnce(ctx: { timestamp: number }) {
    if (ctx.timestamp === lastTimestamp) {
      return;
    }
    lastTimestamp = ctx.timestamp;
    manager.updateAllPositionFees();
    strategy.setCurrentTime(ctx.timestamp);
    strategy.execute();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
