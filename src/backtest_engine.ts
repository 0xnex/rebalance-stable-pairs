import * as fs from "fs";
import * as path from "path";
import { Pool } from "./pool";
import {
  importEvents,
  EventType,
  EventTypes,
  type MomentumEvent,
  processSwapEvent,
  processAddLiquidityEvent,
  processRemoveLiquidityEvent,
} from "./event_importer";
import { VirtualPositionManager } from "./virtual_position_mgr";
import { VaultSnapshotTracker } from "./vault_snapshot_tracker";
import { PositionSnapshotTracker } from "./position_snapshot_tracker";

export type BacktestEventKind =
  | "swap"
  | "addLiquidity"
  | "removeLiquidity"
  | "repayFlashSwap";

export type BacktestMomentumEvent = {
  kind: BacktestEventKind;
  timestamp: number;
  txDigest: string;
  eventSeq: number;
  raw: any;
};

export type BacktestConfig = {
  poolId: string;
  startTime: number;
  endTime: number;
  stepMs?: number;
  dataDir: string;
  strategyFactory: (pool: Pool) => BacktestStrategy;
  logger?: Partial<Console>;
  poolSeedEndTime?: number; // Optional: time to seed pool up to (defaults to startTime)
  metricsIntervalMs?: number; // Optional interval for performance sampling
  poolSeedEventCount?: number; // Optional: number of earliest events to seed before backtest
};

export interface BacktestStrategy {
  readonly id: string;
  readonly manager: VirtualPositionManager;
  onInit(ctx: StrategyContext): Promise<void> | void;
  onTick(ctx: StrategyContext): Promise<void> | void;
  onEvent?(
    ctx: StrategyContext,
    event: BacktestMomentumEvent
  ): Promise<void> | void;
  onFinish?(ctx: StrategyContext): Promise<void> | void;
}

export type StrategyContext = {
  timestamp: number;
  stepIndex: number;
  pool: Pool;
  manager: VirtualPositionManager;
  logger?: Partial<Console>;
};

export type PositionInfo = {
  id: string;
  tickLower: number;
  tickUpper: number;
  priceLower: number;
  priceUpper: number;
  midPrice: number;
  widthPercent: number;
  isActive: boolean;
  liquidity: string;
  amountA: string;
  amountB: string;
  distanceFromCurrentPercent: number;
};

export type BacktestReport = {
  poolId: string;
  startTime: number;
  endTime: number;
  stepMs: number;
  eventsProcessed: number;
  ticks: number;
  strategyId: string;
  totals: ReturnType<VirtualPositionManager["getTotals"]>;
  performance: PerformanceSummary;
  finalState: {
    currentPrice: number;
    currentTick: number;
    liquidity: string;
    openPositions: PositionInfo[];
  };
};

type PerformanceSample = {
  timestamp: number;
  value: number;
};

type PerformanceSummary = {
  initialValue: number;
  finalValue: number;
  absoluteReturn: number;
  returnPct: number;
  highestValue: number;
  lowestValue: number;
  maxDrawdownPct: number;
  samples: PerformanceSample[];
};

class PerformanceTracker {
  private initialValue: number | null = null;
  private finalValue: number | null = null;
  private highestValue = -Infinity;
  private lowestValue = Infinity;
  private peakValue = -Infinity;
  private maxDrawdownPct = 0;
  private lastSampleTs: number | null = null;
  private readonly samples: PerformanceSample[] = [];

  constructor(
    private readonly pool: Pool,
    private readonly manager: VirtualPositionManager,
    private readonly intervalMs: number
  ) {}

  record(timestamp: number, force = false) {
    const value = this.computeValue();
    if (this.initialValue === null) {
      this.initialValue = value;
    }
    this.finalValue = value;

    if (value > this.highestValue) this.highestValue = value;
    if (value < this.lowestValue) this.lowestValue = value;

    if (value > this.peakValue) {
      this.peakValue = value;
    } else if (this.peakValue > 0) {
      const drawdown = ((this.peakValue - value) / this.peakValue) * 100;
      if (drawdown > this.maxDrawdownPct) this.maxDrawdownPct = drawdown;
    }

    if (
      force ||
      this.intervalMs <= 0 ||
      this.lastSampleTs === null ||
      timestamp - this.lastSampleTs >= this.intervalMs
    ) {
      this.samples.push({ timestamp, value });
      this.lastSampleTs = timestamp;
    }
  }

  summary(): PerformanceSummary {
    const initialValue = this.initialValue ?? 0;
    const finalValue = this.finalValue ?? initialValue;
    const absoluteReturn = finalValue - initialValue;
    const returnPct =
      initialValue !== 0 ? (absoluteReturn / initialValue) * 100 : 0;

    return {
      initialValue,
      finalValue,
      absoluteReturn,
      returnPct,
      highestValue:
        this.highestValue === -Infinity ? finalValue : this.highestValue,
      lowestValue:
        this.lowestValue === Infinity ? finalValue : this.lowestValue,
      maxDrawdownPct: this.maxDrawdownPct,
      samples: [...this.samples],
    };
  }

  private computeValue(): number {
    const totals = this.manager.getTotals();
    const price = this.pool.price;

    const amountA = Number(totals.amountA ?? 0n);
    const amountB = Number(totals.amountB ?? 0n);
    const cashA = Number(
      (totals as any).cashAmountA ?? totals.initialAmountA ?? 0n
    );
    const cashB = Number(
      (totals as any).cashAmountB ?? totals.initialAmountB ?? 0n
    );
    const fees0 = Number(totals.feesOwed0 ?? 0n);
    const fees1 = Number(totals.feesOwed1 ?? 0n);
    const costA = (totals as any).totalCostTokenA ?? 0;
    const costB = (totals as any).totalCostTokenB ?? 0;

    const valueTokenB = cashB + amountB + fees1;
    const valueTokenAinB = (cashA + amountA + fees0) * price;
    const costValue = costB + costA * price;
    return valueTokenB + valueTokenAinB - costValue;
  }
}

export class BacktestEngine {
  private readonly stepMs: number;
  private readonly logger?: Partial<Console>;
  private readonly metricsIntervalMs: number;
  private vaultTracker?: VaultSnapshotTracker;
  private positionTracker?: PositionSnapshotTracker;

  constructor(private readonly config: BacktestConfig) {
    if (config.endTime <= config.startTime) {
      throw new Error("endTime must be greater than startTime");
    }
    this.stepMs = config.stepMs ?? 1000;
    this.logger = config.logger;
    this.metricsIntervalMs = config.metricsIntervalMs ?? 60_000;
  }

  async run(): Promise<BacktestReport | undefined> {
    const {
      poolId,
      startTime,
      endTime,
      dataDir,
      poolSeedEndTime,
      poolSeedEventCount,
    } = this.config;
    const seedEndTime = poolSeedEndTime || startTime;

    this.logger?.log?.(
      `[backtest] seeding pool ${poolId} up to ${new Date(
        seedEndTime
      ).toISOString()}`
    );

    const pool = await importEvents(poolId, seedEndTime, undefined, {
      silent: true,
      dataDir,
      seedEventCount: poolSeedEventCount,
    });

    const strategy = this.config.strategyFactory(pool);
    const manager = strategy.manager;
    const performance = new PerformanceTracker(
      pool,
      manager,
      this.metricsIntervalMs
    );

    // Initialize snapshot trackers
    this.vaultTracker = new VaultSnapshotTracker(manager, pool, "./snapshots");
    this.positionTracker = new PositionSnapshotTracker(
      manager,
      pool,
      "./snapshots"
    );

    // Enable CSV streaming to avoid memory buildup for large backtests
    this.vaultTracker.enableCsvStreaming(poolId);
    this.positionTracker.enableCsvStreaming(poolId);

    const events = this.loadEvents(
      dataDir,
      poolId,
      startTime,
      endTime,
      poolSeedEventCount
    );
    this.logger?.log?.(
      `[backtest] loaded ${events.length} events between ${new Date(
        startTime
      ).toISOString()} and ${new Date(endTime).toISOString()}`
    );

    const ctxBase = {
      pool,
      manager,
      logger: this.logger,
    } as const;

    await strategy.onInit({ ...ctxBase, timestamp: startTime, stepIndex: 0 });
    performance.record(startTime, true);

    // Initialize snapshot tracking
    this.vaultTracker.initialize(startTime);
    this.positionTracker.initialize(startTime);

    let stepIndex = 0;
    let timestamp = startTime;
    let eventPtr = 0;
    const stepMs = this.stepMs;
    const totalSteps = Math.ceil((endTime - startTime) / stepMs);

    while (timestamp <= endTime) {
      // Process events up to this timestamp window
      while (
        eventPtr < events.length &&
        events[eventPtr]?.timestamp !== undefined &&
        events[eventPtr]!.timestamp <= timestamp
      ) {
        const ev = events[eventPtr];
        if (ev) {
          this.applyEvent(pool, ev);
          manager.updateAllPositionFees();
          if (strategy.onEvent) {
            await strategy.onEvent({ ...ctxBase, timestamp, stepIndex }, ev);
            performance.record(timestamp);
          }
        }
        eventPtr += 1;
      }

      await strategy.onTick({ ...ctxBase, timestamp, stepIndex });
      manager.updateAllPositionFees();
      performance.record(timestamp);

      // Update snapshot trackers
      this.vaultTracker?.update(timestamp);
      this.positionTracker?.update(timestamp);

      stepIndex += 1;
      timestamp = startTime + stepIndex * stepMs;
      if (stepIndex > totalSteps) break;
    }

    performance.record(endTime, true);
    if (strategy.onFinish) {
      await strategy.onFinish({ ...ctxBase, timestamp: endTime, stepIndex });
    }

    // Save snapshot reports
    const reportTimestamp = Date.now();
    this.vaultTracker?.saveSnapshots(`vault_${poolId}_${reportTimestamp}.json`);
    this.positionTracker?.saveSnapshots(
      `position_${poolId}_${reportTimestamp}.json`
    );

    this.logger?.log?.(`📊 Snapshot reports saved to ./snapshots/`);

    // Collect final position information
    const openPositions = this.collectPositionInfo(pool, manager);

    return {
      poolId,
      startTime,
      endTime,
      stepMs,
      eventsProcessed: eventPtr,
      ticks: stepIndex,
      strategyId: strategy.id,
      totals: manager.getTotals(),
      performance: performance.summary(),
      finalState: {
        currentPrice: pool.price,
        currentTick: pool.tickCurrent,
        liquidity: pool.liquidity.toString(),
        openPositions,
      },
    };
  }

  private collectPositionInfo(
    pool: Pool,
    manager: VirtualPositionManager
  ): PositionInfo[] {
    const positions = manager.getAllPositions();
    const Q64 = 1n << 64n;

    return positions.map((pos) => {
      // Convert ticks to prices
      const sqrtLower =
        Number(pool.tickToSqrtPrice(pos.tickLower)) / Number(Q64);
      const sqrtUpper =
        Number(pool.tickToSqrtPrice(pos.tickUpper)) / Number(Q64);
      const priceLower = sqrtLower * sqrtLower;
      const priceUpper = sqrtUpper * sqrtUpper;
      const midPrice = (priceLower + priceUpper) / 2;
      const widthPercent = ((priceUpper - priceLower) / midPrice) * 100;

      // Check if position is active (current tick is in range)
      const isActive =
        pool.tickCurrent >= pos.tickLower && pool.tickCurrent < pos.tickUpper;

      // Calculate distance from current price
      const distanceFromCurrentPercent =
        ((midPrice - pool.price) / pool.price) * 100;

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
        amountA: pos.amountA.toString(),
        amountB: pos.amountB.toString(),
        distanceFromCurrentPercent,
      };
    });
  }

  private applyEvent(pool: Pool, event: BacktestMomentumEvent) {
    switch (event.kind) {
      case "swap":
        processSwapEvent(pool, event.raw);
        break;
      case "addLiquidity":
        processAddLiquidityEvent(pool, event.raw);
        break;
      case "removeLiquidity":
        processRemoveLiquidityEvent(pool, event.raw);
        break;
      case "repayFlashSwap":
        // no state change required for strategy; skip
        break;
      default:
        break;
    }
  }

  private loadEvents(
    dir: string,
    poolId: string,
    startTime: number,
    endTime: number,
    skipEventCount?: number
  ): BacktestMomentumEvent[] {
    if (!fs.existsSync(dir)) {
      throw new Error(`Data directory ${dir} not found`);
    }

    const stat = fs.statSync(dir);
    if (!stat.isDirectory()) {
      throw new Error(`Data path ${dir} is not a directory`);
    }

    let workingDir = dir;
    const entries = fs.readdirSync(dir);
    const hasJson = entries.some((file) => file.endsWith(".json"));
    if (!hasJson) {
      const candidate = path.join(dir, poolId);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        workingDir = candidate;
      }
    }

    const files = fs
      .readdirSync(workingDir)
      .filter((file) => file.endsWith(".json"))
      .sort();

    const events: BacktestMomentumEvent[] = [];
    const skipCount = skipEventCount ?? 0;
    let processedEvents = 0;

    outer: for (const file of files) {
      const full = path.join(workingDir, file);
      try {
        const content = fs.readFileSync(full, "utf8");
        const parsed = JSON.parse(content);
        const data = parsed.data ?? [];
        for (const tx of data) {
          const ts = Number(tx.timestampMs);
          if (!Number.isFinite(ts)) continue;
          if (ts > endTime) break outer;

          for (const ev of tx.events as MomentumEvent[]) {
            const type = ev.type;
            const json = ev.parsedJson;
            if (!json || json.pool_id?.toLowerCase() !== poolId.toLowerCase()) {
              continue;
            }

            if (processedEvents < skipCount) {
              processedEvents += 1;
              continue;
            }

            processedEvents += 1;

            if (ts < startTime) {
              continue;
            }

            const kind = this.mapEventKind(type);
            if (!kind) continue;

            events.push({
              kind,
              timestamp: ts,
              txDigest: tx.digest,
              eventSeq: Number(ev.id.eventSeq ?? 0),
              raw: json,
            });
          }
        }
      } catch (err) {
        this.logger?.warn?.(`failed to parse ${full}: ${err}`);
        continue;
      }
    }

    events.sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      if (a.txDigest !== b.txDigest)
        return a.txDigest.localeCompare(b.txDigest);
      return a.eventSeq - b.eventSeq;
    });

    return events;
  }

  private mapEventKind(type: string): BacktestEventKind | null {
    switch (type) {
      case EventTypes[EventType.Swap]:
        return "swap";
      case EventTypes[EventType.AddLiquidity]:
        return "addLiquidity";
      case EventTypes[EventType.RemoveLiquidity]:
        return "removeLiquidity";
      case EventTypes[EventType.RepayFlashSwap]:
        return "repayFlashSwap";
      default:
        return null;
    }
  }
}
