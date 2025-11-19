import { Pool } from "./pool";
import { importEvents } from "./event_importer";
import { VirtualPositionManager } from "./virtual_position_mgr";
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
  liquidity: bigint; // Pool's active liquidity at the time of swap
};

export type BacktestConfig = {
  poolId: string;
  startTime: number;
  endTime: number;
  decimals0: number;
  decimals1: number;
  token0Name?: string; // optional token name for display
  token1Name?: string; // optional token name for display
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
  manager: VirtualPositionManager;
  pool: Pool;
  strategy: BacktestStrategy;

  constructor(private readonly config: BacktestConfig) {
    if (config.endTime <= config.startTime) {
      throw new Error("endTime must be greater than startTime");
    }

    if (!config.token0Name || !config.token1Name) {
      throw new Error("token0Name and token1Name are required");
    }

    this.stepMs = config.stepMs ?? 1000;
    this.logger = config.logger;
    this.metricsIntervalMs = config.metricsIntervalMs ?? 60_000;

    this.pool = new Pool(
      config.token0Name,
      config.token1Name,
      config.decimals0,
      config.decimals1,
      config.feeRatePpm,
      config.tickSpacing
    );

    if (config.invest0 < 0n || config.invest1 < 0n) {
      throw new Error("no funds provided");
    }

    const tokenConfig = {
      token0Name: config.token0Name || "Token0",
      token1Name: config.token1Name || "Token1",
      token0Decimals: config.decimals0,
      token1Decimals: config.decimals1,
    };

    this.manager = new VirtualPositionManager(
      config.invest0 || 0n,
      config.invest1 || 0n,
      this.pool
    );

    this.strategy = this.config.strategyFactory(this.pool, this.manager);
  }

  private async initialize(startTime: number): Promise<void> {
    await this.strategy.onInit({
      pool: this.pool,
      manager: this.manager,
      logger: this.logger,
      timestamp: startTime,
      stepIndex: 0,
    });
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

      eventsProcessed.count++;
      i++;
    }

    // Remove processed events from buffer
    eventBuffer.splice(0, i);

    // Execute strategy tick (time-based logic)
    await this.strategy.onTick(ctx);
  }

  private async finalize(endTime: number, stepIndex: number): Promise<void> {
    const ctx = {
      timestamp: endTime,
      stepIndex,
      pool: this.pool,
      manager: this.manager,
      logger: this.logger,
    };
    this.logger?.log?.(`Snapshot reports saved to ./snapshots/`);
    this.strategy.onFinish?.(ctx);
  }

  async run(): Promise<void> {
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
    return await this.finalize(endTime, stepIndex);
  }
}
