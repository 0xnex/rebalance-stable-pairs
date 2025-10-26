#!/usr/bin/env bun
/**
 * Backtest Entry Program
 * 
 * Command-line interface for running backtests with strategies.
 * Uses a backtest engine that emits per-second ticks for strategy synchronization.
 * 
 * Usage:
 *   bun run src/backtest.ts --poolId <POOL_ID> --start <ISO_DATE> --end <ISO_DATE> [options]
 * 
 * Example:
 *   bun run src/backtest.ts \
 *     --poolId 0x737ec... \
 *     --start "2025-08-20T00:00:00Z" \
 *     --end "2025-08-21T00:00:00Z" \
 *     --token0 USDC \
 *     --token1 USDT \
 *     --output ./results
 */

import { createSwapEventGenerator } from "./event_importer";
import { SimplePool } from "./simple_pool";
import { PositionManager } from "./position_mgr";
import { FixedSlippageProvider, LinearSlippageEstimator } from "./slippage_estimator";
import { PerformanceTracker } from "./performance_tracker";
import { calculateFundPerformance, calculatePositionsPerformance } from "./performance_exporter";
import { join } from "node:path";
import type { SwapEvent, IStrategy, BacktestContext } from "./types";

// ============================================================================
// CLI Argument Parser
// ============================================================================

/**
 * Common backtest configuration (non-strategy-specific)
 */
export interface BacktestConfig {
  poolId: string;
  startTime: Date;
  endTime: Date;
  initialAmount0: bigint;
  initialAmount1: bigint;
  token0Name: string;
  token1Name: string;
  decimals0: number;
  decimals1: number;
  dataDir?: string;
  output: string;
  tickSpacing: number;
  feeTier: number;
  tickIntervalMs: number;
  silent: boolean;
}

/**
 * Parse common backtest CLI arguments, leaving unknown args for strategy-specific parsing
 * 
 * This function is used by strategy runners to avoid duplicating CLI parsing logic.
 * 
 * @param argv - Command line arguments (default: process.argv.slice(2))
 * @returns Object with parsed config and remaining unparsed arguments
 * 
 * @example
 * // In your strategy runner script:
 * const { config, unparsedArgs } = parseBacktestArgs();
 * 
 * // Now parse strategy-specific args from unparsedArgs
 * const strategyParams = parseStrategyArgs(unparsedArgs);
 * 
 * // Execute backtest
 * await execute({ strategy: new MyStrategy(strategyParams), ...config });
 */
export function parseBacktestArgs(argv: string[] = process.argv.slice(2)): {
  config: Partial<BacktestConfig>;
  unparsedArgs: string[];
  help: boolean;
} {
  const config: Partial<BacktestConfig> = {
    initialAmount0: 10_000_000n,
    initialAmount1: 10_000_000n,
    token0Name: "TOKEN0",
    token1Name: "TOKEN1",
    decimals0: 6,
    decimals1: 6,
    output: "./backtest-results",
    tickSpacing: 10,
    feeTier: 3000,
    tickIntervalMs: 1000,
    silent: false,
  };

  const unparsedArgs: string[] = [];
  let help = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];

    let parsed = true;

    switch (arg) {
      case "--poolId":
      case "-p":
        config.poolId = next;
        i++;
        break;

      case "--start":
      case "-s":
        if (next) {
          config.startTime = new Date(next);
          i++;
        }
        break;

      case "--end":
      case "-e":
        if (next) {
          config.endTime = new Date(next);
          i++;
        }
        break;

      case "--initialAmount0":
      case "--init0":
        if (next) {
          config.initialAmount0 = BigInt(next);
          i++;
        }
        break;

      case "--initialAmount1":
      case "--init1":
        if (next) {
          config.initialAmount1 = BigInt(next);
          i++;
        }
        break;

      case "--token0":
        if (next) {
          config.token0Name = next;
          i++;
        }
        break;

      case "--token1":
        if (next) {
          config.token1Name = next;
          i++;
        }
        break;

      case "--decimals0":
        if (next) {
          config.decimals0 = parseInt(next);
          i++;
        }
        break;

      case "--decimals1":
        if (next) {
          config.decimals1 = parseInt(next);
          i++;
        }
        break;

      case "--dataDir":
      case "-d":
        if (next) {
          config.dataDir = next;
          i++;
        }
        break;

      case "--output":
      case "-o":
        if (next) {
          config.output = next;
          i++;
        }
        break;

      case "--tickInterval":
        if (next) {
          config.tickIntervalMs = parseInt(next);
          i++;
        }
        break;

      case "--tickSpacing":
        if (next) {
          config.tickSpacing = parseInt(next);
          i++;
        }
        break;

      case "--feeTier":
        if (next) {
          config.feeTier = parseInt(next);
          i++;
        }
        break;

      case "--silent":
        config.silent = true;
        break;

      case "--help":
      case "-h":
        help = true;
        break;

      default:
        // Unknown argument - let strategy parser handle it
        parsed = false;
        if (arg !== undefined) {
          unparsedArgs.push(arg);
          // If this arg consumed a value, add it too
          if (next !== undefined && !next.startsWith("-")) {
            unparsedArgs.push(next);
            i++;
          }
        }
    }
  }

  return { config, unparsedArgs, help };
}

// ============================================================================
// Backtest Engine
// ============================================================================

/**
 * Execute backtest with strategy and configuration
 * Used by strategy runner scripts to trigger backtests
 */
export async function execute(config: BacktestConfig & { strategy: IStrategy }): Promise<void> {
  // Validate required parameters
  if (!config.poolId) {
    throw new Error("poolId is required");
  }
  if (!config.startTime) {
    throw new Error("startTime is required");
  }
  if (!config.endTime) {
    throw new Error("endTime is required");
  }
  if (config.startTime >= config.endTime) {
    throw new Error("startTime must be before endTime");
  }

  if (!config.silent) {
    console.log("\n[INIT] [backtest] [started]");
    console.log(`[CONFIG] [pool.id] [${config.poolId}]`);
    console.log(`[CONFIG] [token0] [${config.token0Name}] [decimals=${config.decimals0}]`);
    console.log(`[CONFIG] [token1] [${config.token1Name}] [decimals=${config.decimals1}]`);
    console.log(`[CONFIG] [period.start] [${config.startTime.toISOString()}]`);
    console.log(`[CONFIG] [period.end] [${config.endTime.toISOString()}]`);
    console.log(`[CONFIG] [period.duration_hours] [${((config.endTime.getTime() - config.startTime.getTime()) / 1000 / 60 / 60).toFixed(2)}]`);
    console.log(`[CONFIG] [initial.amount0] [${Number(config.initialAmount0)}]`);
    console.log(`[CONFIG] [initial.amount1] [${Number(config.initialAmount1)}]`);
    console.log(`[CONFIG] [tick_interval_ms] [${config.tickIntervalMs}]`);
    console.log(`[CONFIG] [output_dir] [${config.output}]`);
  }

  // Create slippage provider with sensible defaults (internal implementation)
  // Using linear model with 0.1% base rate and 5% max
  const slippageProvider = new LinearSlippageEstimator(
    0.001,    // 0.1% base slippage
    1000000,  // reserve threshold
    0.05      // 5% max slippage
  );

  // Create pool with token names
  const pool = new SimplePool(
    config.token0Name,
    config.token1Name,
    config.decimals0,
    config.decimals1,
    config.feeTier,
    config.tickSpacing,
    slippageProvider
  );

  // Calculate time range
  const startMs = config.startTime.getTime();
  const endMs = config.endTime.getTime();

  // Create position manager with initial simulation time
  const manager = new PositionManager(config.initialAmount0, config.initialAmount1, pool, startMs);

  // Create performance tracker
  const performanceTracker = new PerformanceTracker(
    pool,
    manager,
    config.initialAmount0,
    config.initialAmount1,
    startMs,
    config.output,
    config.silent
  );

  // Create event generator
  if (!config.silent) {
    console.log("\n[INIT] [event_generator] [creating]");
  }

  const eventGenerator = createSwapEventGenerator({
    poolId: config.poolId,
    endTime: endMs,
    startTime: startMs,
    dataDir: config.dataDir,
    silent: config.silent,
  });

  if (!config.silent) {
    console.log("[ENGINE] [backtest] [starting]");
  }

  // Create backtest context for strategy
  const createContext = (currentTime: number): BacktestContext => ({
    pool,
    positionManager: manager,
    currentTime,
  });

  // Initialize strategy AFTER processing first event to ensure pool has valid price
  let strategyInitialized = false;

  // Stream events and emit time ticks
  let eventCount = 0;
  let tickCount = 0;
  let currentTime = startMs;
  const totalTicks = Math.floor((endMs - startMs) / config.tickIntervalMs);
  const nextTickTime = () => currentTime + config.tickIntervalMs;

  // Process events as they stream in
  // Event-driven backtest: only emit ticks when there are swap events to react to
  for await (const event of eventGenerator) {
    // 1. Update pool state with swap event (price/tick/liquidity changes)
    pool.onSwapEvent(event);
    eventCount++;
    
    // Initialize strategy after first event (pool now has valid price)
    if (!strategyInitialized) {
      if (!config.silent) {
        console.log(`[INIT] [pool_price] [${pool.price().toFixed(6)}]`);
        console.log(`[INIT] [pool_tick] [${pool.getTick()}]`);
        console.log(`[INIT] [strategy] [starting]`);
      }
      config.strategy.onStart(createContext(startMs));
      strategyInitialized = true;
    }

    // 2. Distribute fees to positions based on swap event
    manager.onSwapEvent(event);

    // 3. Emit all time ticks that should have occurred up to this swap event
    // Strategy can now see the updated pool state and make decisions
    while (currentTime <= endMs && event.timestamp >= nextTickTime()) {
      const tickTime = nextTickTime();
      
      // Emit time tick event to strategy
      config.strategy.onTick(tickTime, createContext(tickTime));
      tickCount++;
      
      // Emit time tick event to performance tracker
      await performanceTracker.onTimeTick(tickTime);
      
      currentTime = tickTime + config.tickIntervalMs;

      // Progress indicator
      if (!config.silent && tickCount % 1000 === 0) {
        const progress = (tickCount / totalTicks * 100).toFixed(1);
        const snapshotCount = performanceTracker.getSnapshotCount();
        const shouldLogProgress = snapshotCount % 10 !== 0 || currentTime < tickTime;
        if (shouldLogProgress) {
          process.stdout.write(`\r[ENGINE] [backtest] [running] [progress=${progress}%] [ticks=${tickCount}/${totalTicks}] [events_processed=${eventCount}] [snapshots=${snapshotCount}]`);
        }
      }
    }
  }

  // Note: We do NOT emit ticks after all swap events are done
  // Ticks without price changes (swap events) cannot impact strategy decisions

  if (!config.silent) {
    const snapshotCount = performanceTracker.getSnapshotCount();
    process.stdout.write(`\r[ENGINE] [backtest] [completed] [progress=100.0%] [ticks=${tickCount}/${totalTicks}] [events_processed=${eventCount}] [snapshots=${snapshotCount}]       \n`);
  }

  // Set final simulation time before calling strategy onEnd
  manager.setCurrentTime(endMs);

  // Finalize strategy
  config.strategy.onEnd(createContext(endMs));

  // Capture final snapshot
  await performanceTracker.captureFinalSnapshot(endMs);

  if (!config.silent) {
    const snapshotCount = performanceTracker.getSnapshotCount();
    console.log(`\n[EXPORT] [performance] [complete] [total_snapshots=${snapshotCount}]`);
  }

  // Read final metrics for summary
  const fundPerformance = calculateFundPerformance(
    pool,
    manager,
    config.initialAmount0,
    config.initialAmount1,
    endMs
  );
  
  const positionsPerformance = calculatePositionsPerformance(
    pool,
    manager,
    endMs
  );

  // Get CSV paths
  const fundCsvPath = join(config.output, "fund_performance.csv");
  const positionsCsvPath = join(config.output, "position_performance.csv");

  if (!config.silent) {
    console.log(`[EXPORT] [performance] [exported]`);
    console.log(`[OUTPUT] [fund_csv] [${fundCsvPath}]`);
    console.log(`[OUTPUT] [positions_csv] [${positionsCsvPath}]`);

    // Calculate APR based on backtest duration
    const durationMs = config.endTime.getTime() - config.startTime.getTime();
    const durationDays = durationMs / (1000 * 60 * 60 * 24);
    const durationYears = durationDays / 365;
    
    // Simple APR: annualize the ROI (not compounded)
    const apr = fundPerformance.roiPercent / durationYears;
    
    // APY: compound the return to annual (more accurate for comparing strategies)
    const dailyReturn = fundPerformance.roiPercent / 100 / durationDays;
    const apy = (Math.pow(1 + dailyReturn, 365) - 1) * 100;

    // Print summary
    console.log("\n[SUMMARY] [backtest] [results]");
    console.log(`[SUMMARY] [period.start] [${config.startTime.toISOString()}]`);
    console.log(`[SUMMARY] [period.end] [${config.endTime.toISOString()}]`);
    console.log(`[SUMMARY] [period.duration_days] [${durationDays.toFixed(2)}]`);
    console.log(`[SUMMARY] [events.processed] [${eventCount}]`);
    console.log(`[SUMMARY] [ticks.elapsed] [${tickCount}]`);
    console.log(`[SUMMARY] [value.initial] [${fundPerformance.initialValue}] [token=${config.token1Name}]`);
    console.log(`[SUMMARY] [value.final] [${fundPerformance.totalValue}] [token=${config.token1Name}]`);
    console.log(`[SUMMARY] [pnl] [${fundPerformance.pnl}] [token=${config.token1Name}]`);
    console.log(`[SUMMARY] [roi_percent] [${fundPerformance.roiPercent.toFixed(4)}]`);
    console.log(`[SUMMARY] [apr] [${apr.toFixed(4)}]`);
    console.log(`[SUMMARY] [apy] [${apy.toFixed(4)}]`);
    console.log(`[SUMMARY] [fees.earned] [${fundPerformance.totalFeeEarned}] [token=${config.token1Name}]`);
    
    // Log position-level performance
    console.log("\n[SUMMARY] [positions] [performance]");
    for (const posPerf of positionsPerformance) {
      console.log(
        `[POSITION_SUMMARY] [id=${posPerf.positionId}] ` +
        `[range=${posPerf.lowerTick}:${posPerf.upperTick}] ` +
        `[status=${posPerf.status}] ` +
        `[pnl=${posPerf.pnl}] ` +
        `[roi=${posPerf.roiPercent.toFixed(4)}%] ` +
        `[apr=${posPerf.apr.toFixed(4)}%] ` +
        `[apy=${posPerf.apy.toFixed(4)}%] ` +
        `[duration_days=${posPerf.durationDays.toFixed(2)}] ` +
        `[in_range=${posPerf.inRangePercent.toFixed(2)}%] ` +
        `[fees_earned=${posPerf.totalFeeEarned}]`
      );
    }
    
    console.log("\n[COMPLETE] [backtest] [success]\n");
  }
}
