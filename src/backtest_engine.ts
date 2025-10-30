import { Pool } from "./pool";
import { importEvents } from "./event_importer";
import { VirtualPositionManager } from "./virtual_position_mgr";
import { VaultSnapshotTracker } from "./vault_snapshot_tracker";
import { PositionSnapshotTracker } from "./position_snapshot_tracker";
import { PerformanceTracker } from "./performance_tracker";
import type { BacktestReport, PositionInfo } from "./backtest_report";
import { LiquidityConstants } from "./liquidity_calculator";

// only process swap event
export type SwapEvent = {
  timestampMs: number;
  digest: string;
  seq: number;
  amountIn: bigint;
  amountOut: bigint;
  sqrtPriceBeforeX64: bigint;
  sqrtPriceAfterX64: bigint;
  zeroForOne: boolean;
  fee: bigint;
  protocolFee: bigint;
  reserve0: bigint;
  reserve1: bigint;
  tick: number;
};

export type BacktestConfig = {
  poolId: string;
  startTime: number;
  endTime: number;
  decimals0: number;
  decimals1: number;
  feeRatePpm: number;
  tickSpacing: number;
  stepMs?: number;
  dataDir?: string;
  strategyFactory: (
    pool: Pool,
    manager: VirtualPositionManager
  ) => BacktestStrategy;
  logger?: Partial<Console>;
  poolSeedEndTime?: number; // Optional: time to seed pool up to (defaults to startTime)
  metricsIntervalMs?: number; // Optional interval for performance sampling
  poolSeedEventCount?: number; // Optional: number of earliest events to seed before backtest
  invest0: bigint; // required invest amount with decimals of token0, default 0,
  invest1: bigint; // required invest amount with decimals of token1, default 0
  simulateErrors?: number; // optional simulate error times before success for open position, default 0
};

export interface BacktestStrategy {
  readonly id: string;
  onInit(ctx: StrategyContext): Promise<void> | void;
  onTick(ctx: StrategyContext): Promise<void> | void;
  onSwapEvent?(ctx: StrategyContext, event: SwapEvent): Promise<void> | void;
  onFinish?(ctx: StrategyContext): Promise<void> | void;
}

export type StrategyContext = {
  timestamp: number;
  stepIndex: number;
  pool: Pool;
  manager: VirtualPositionManager;
  logger?: Partial<Console>;
};

export class BacktestEngine {
  private readonly stepMs: number;
  private readonly logger?: Partial<Console>;
  private readonly metricsIntervalMs: number;
  vaultTracker?: VaultSnapshotTracker;
  positionTracker?: PositionSnapshotTracker;
  manager: VirtualPositionManager;
  pool: Pool;
  strategy: BacktestStrategy;
  performance: PerformanceTracker;

  constructor(private readonly config: BacktestConfig) {
    if (config.endTime <= config.startTime) {
      throw new Error("endTime must be greater than startTime");
    }
    if (config.decimals0 <= 0) {
      config.decimals0 = 8;
    }
    if (config.decimals1 <= 0) {
      config.decimals1 = 8;
    }

    if (config.feeRatePpm <= 0) {
      config.feeRatePpm = 100;
    }

    if (config.tickSpacing <= 0) {
      config.tickSpacing = 2;
    }

    this.stepMs = config.stepMs ?? 1000;
    this.logger = config.logger;
    this.metricsIntervalMs = config.metricsIntervalMs ?? 60_000;

    this.pool = new Pool(
      config.decimals0,
      config.decimals1,
      config.feeRatePpm,
      config.tickSpacing
    );

    if (config.invest0 < 0n || config.invest1 < 0n) {
      throw new Error("no funds provided");
    }
    this.manager = new VirtualPositionManager(
      config.invest0 || 0n,
      config.invest1 || 0n,
      this.pool,
      config.simulateErrors || 0
    );

    this.strategy = this.config.strategyFactory(this.pool, this.manager);
    this.performance = new PerformanceTracker(
      this.pool,
      this.manager,
      this.metricsIntervalMs,
      this.config.decimals0,
      this.config.decimals1
    );
  }

  private async initialize(startTime: number): Promise<void> {
    await this.strategy.onInit({
      pool: this.pool,
      manager: this.manager,
      logger: this.logger,
      timestamp: startTime,
      stepIndex: 0,
    });
    this.performance.record(startTime, true);
    this.vaultTracker = new VaultSnapshotTracker(
      this.manager,
      this.pool,
      "./snapshots"
    );
    this.positionTracker = new PositionSnapshotTracker(
      this.manager,
      this.pool,
      "./snapshots"
    );
    this.vaultTracker.enableCsvStreaming(this.config.poolId);
    this.positionTracker.enableCsvStreaming(this.config.poolId);
    this.vaultTracker.initialize(startTime);
    this.positionTracker.initialize(startTime);
  }

  private async processStep(
    timestamp: number,
    stepIndex: number,
    eventBuffer: SwapEvent[],
    eventsProcessed: { count: number }
  ): Promise<void> {
    const ctx = {
      timestamp,
      stepIndex,
      pool: this.pool,
      manager: this.manager,
      logger: this.logger,
    };

    // Process all events in current time window
    let i = 0;
    while (i < eventBuffer.length && eventBuffer[i]!.timestampMs <= timestamp) {
      const ev = eventBuffer[i]!;

      // Update pool state with swap event
      this.pool.update(ev);

      // Update position fees based on swap
      this.manager.updateAllPositionFees(ev);

      // Notify strategy of swap event
      await this.strategy.onSwapEvent?.(ctx, ev);
      this.performance.record(timestamp);

      eventsProcessed.count++;
      i++;
    }

    // Remove processed events from buffer
    eventBuffer.splice(0, i);

    // Execute strategy tick (time-based logic)
    await this.strategy.onTick(ctx);
    this.performance.record(timestamp);

    // Update snapshot trackers
    this.vaultTracker?.update(timestamp);
    this.positionTracker?.update(timestamp);
  }

  private async finalize(
    endTime: number,
    stepIndex: number,
    eventsProcessed: number
  ): Promise<BacktestReport> {
    const ctx = {
      timestamp: endTime,
      stepIndex,
      pool: this.pool,
      manager: this.manager,
      logger: this.logger,
    };
    this.performance.record(endTime, true);
    if (this.strategy.onFinish) await this.strategy.onFinish(ctx);
    const reportTimestamp = Date.now();
    this.vaultTracker?.saveSnapshots(
      `vault_${this.config.poolId}_${reportTimestamp}.json`
    );
    this.positionTracker?.saveSnapshots(
      `position_${this.config.poolId}_${reportTimestamp}.json`
    );
    this.logger?.log?.(`📊 Snapshot reports saved to ./snapshots/`);
    const openPositions = this.collectPositionInfo();
    return {
      poolId: this.config.poolId,
      startTime: this.config.startTime,
      endTime: this.config.endTime,
      stepMs: this.stepMs,
      eventsProcessed,
      ticks: stepIndex,
      strategyId: this.strategy.id,
      totals: this.manager.getTotals(),
      performance: this.performance.summary(),
      finalState: {
        currentPrice: this.pool.price,
        currentTick: this.pool.tickCurrent,
        liquidity: this.pool.liquidity.toString(),
        openPositions,
      },
    };
  }

  async run(): Promise<BacktestReport | undefined> {
    const { poolId, startTime, endTime, dataDir } = this.config;

    this.logger?.log?.(
      `[backtest] Running backtest for pool ${poolId} from ${new Date(
        startTime
      ).toISOString()} to ${new Date(endTime).toISOString()}`
    );

    // Load swap events from event importer
    const eventIterator = importEvents(poolId, { dataDir, startTime, endTime });

    // Load the first event to initialize pool state (but don't process fees yet)
    let nextEvent = await eventIterator.next();
    let firstEventProcessed = false;
    if (!nextEvent.done) {
      this.pool.update(nextEvent.value);
      // DON'T call updateAllPositionFees yet - no positions exist!
      firstEventProcessed = true;
      this.logger?.log?.(
        `[backtest] Initialized pool state from first event: ` +
          `tick=${this.pool.tickCurrent}, price=${this.pool.price.toFixed(6)}`
      );
      // Move to next event - don't reprocess the first one
      nextEvent = await eventIterator.next();
    }

    // Initialize backtest components (now pool has valid state)
    await this.initialize(startTime);

    // Main backtest loop - global clock management
    let stepIndex = 0;
    let timestamp = startTime;
    let eventsProcessed = { count: 0 };
    const totalSteps = Math.ceil((endTime - startTime) / this.stepMs);

    let eventBuffer: SwapEvent[] = [];

    // Execute backtest with time-stepped simulation
    while (timestamp <= endTime) {
      // Load events up to current timestamp
      while (!nextEvent.done && nextEvent.value.timestampMs <= timestamp) {
        eventBuffer.push(nextEvent.value);
        nextEvent = await eventIterator.next();
      }

      // Process events and execute strategy logic for current time step
      await this.processStep(
        timestamp,
        stepIndex,
        eventBuffer,
        eventsProcessed
      );

      // Progress reporting and memory management
      if (stepIndex % 1000 === 0) {
        if (global.gc) global.gc();
        this.logger?.log?.(
          `[backtest] Progress: ${stepIndex}/${totalSteps} steps (${(
            (stepIndex / totalSteps) *
            100
          ).toFixed(1)}%) | Events: ${eventsProcessed.count} | Buffer: ${
            eventBuffer.length
          }`
        );
      }

      // Advance global clock
      stepIndex += 1;
      timestamp = startTime + stepIndex * this.stepMs;
      if (timestamp > endTime) break;
    }

    // Finalize and generate report
    return await this.finalize(endTime, stepIndex, eventsProcessed.count);
  }

  private collectPositionInfo(): PositionInfo[] {
    const positions = this.manager.getAllPositions();
    const Q64 = LiquidityConstants.Q64;

    return positions.map((pos) => {
      // Convert ticks to prices
      const { lower: sqrtLower, upper: sqrtUpper } = pos.sqrtPricesX64();

      // Convert sqrt prices (Q64) to actual prices
      const Q64_SQUARED = Q64 * Q64; // Q128
      const priceLower = Number(sqrtLower * sqrtLower) / Number(Q64_SQUARED);
      const priceUpper = Number(sqrtUpper * sqrtUpper) / Number(Q64_SQUARED);

      // Calculate mid-price as arithmetic mean of actual prices
      const midPrice = (priceLower + priceUpper) / 2;
      const widthPercent = ((priceUpper - priceLower) / midPrice) * 100;

      // Check if position is active (current tick is in range)
      const isActive = pos.isInRange(this.pool.tickCurrent);

      // Calculate distance from current price
      const distanceFromCurrentPercent =
        ((midPrice - this.pool.price) / this.pool.price) * 100;

      const totals = pos.getTotals(this.pool.sqrtPriceX64);

      return {
        id: pos.id,
        tickLower: pos.tickLower,
        tickUpper: pos.tickUpper,
        priceLower,
        priceUpper,
        midPrice,
        widthPercent,
        isActive,
        liquidity: pos.liquidity.toString(),
        amountA: totals.amount0.toString(),
        amountB: totals.amount1.toString(),
        distanceFromCurrentPercent,
      };
    });
  }
}
