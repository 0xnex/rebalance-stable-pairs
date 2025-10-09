import type { BacktestStrategy, StrategyContext } from "../backtest_engine";
import { VirtualPositionManager } from "../virtual_position_mgr";
import { Pool } from "../pool";
import {
  ThreeBandRebalancerStrategy,
  type ThreeBandRebalancerConfig,
} from "./three_band_rebalancer_strategy";

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
    initialAmountB: toBigInt(process.env.THREEBAND_INITIAL_B, 10_000n),
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
    actionCostTokenB: toNumber(process.env.THREEBAND_ACTION_COST_B, 0.02),
    fastSegmentCount: toNumber(process.env.THREEBAND_FAST_COUNT, 2),
    fastIntervalMs: toNumber(process.env.THREEBAND_FAST_INTERVAL_MS, 30_000),
    slowIntervalMs: toNumber(
      process.env.THREEBAND_SLOW_INTERVAL_MS,
      5 * 60 * 1000
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
    minRotationProfitTokenB: toNumber(process.env.THREEBAND_MIN_PROFIT_B, 0.05),

    // Enhanced features (can be disabled for comparison testing)
    enableDynamicAllocation: false,
    enableAdaptiveBandWidth: false,
    enablePredictiveRotation: false,
    enableFeeCompounding: false,
    enableSmartSlippage: false,
    feeCompoundingThresholdPercent: 1.0,
    volatilityWindowMs: 600_000,
    momentumWindowSize: 5,
    activeBandWeightPercent: 60,
  };
}

export function strategyFactory(pool: Pool): BacktestStrategy {
  const env = readEnvConfig();
  const manager = new VirtualPositionManager(pool);
  manager.setInitialBalances(env.initialAmountA, env.initialAmountB);

  const config: Partial<ThreeBandRebalancerConfig> = {
    segmentCount: env.segmentCount,
    segmentRangePercent: env.segmentRangePercent,
    checkIntervalMs: env.checkIntervalMs,
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
    ctx.logger?.log?.(
      `[three-band] ${new Date(
        ctx.timestamp
      ).toISOString()} action=${action} msg=${message}`
    );
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
