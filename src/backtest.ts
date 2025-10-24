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
import { exportPerformanceToCSV, calculateFundPerformance, calculatePositionsPerformance } from "./performance_exporter";
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

  // Create position manager
  const manager = new PositionManager(config.initialAmount0, config.initialAmount1, pool);

  // Create event generator
  if (!config.silent) {
    console.log("\n[INIT] [event_generator] [creating]");
  }

  const startMs = config.startTime.getTime();
  const endMs = config.endTime.getTime();

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

  // Initialize strategy
  config.strategy.onStart(createContext(startMs));

  // Stream events and emit time ticks
  let eventCount = 0;
  let tickCount = 0;
  let currentTime = startMs;
  const totalTicks = Math.floor((endMs - startMs) / config.tickIntervalMs);
  const nextTickTime = () => currentTime + config.tickIntervalMs;

  // Process events as they stream in
  for await (const event of eventGenerator) {
    // Emit all ticks that should have occurred before this event
    while (currentTime <= endMs && event.timestamp >= nextTickTime()) {
      config.strategy.onTick(currentTime, createContext(currentTime));
      tickCount++;
      currentTime += config.tickIntervalMs;

      // Progress indicator
      if (!config.silent && tickCount % 1000 === 0) {
        const progress = (tickCount / totalTicks * 100).toFixed(1);
        process.stdout.write(`\r[ENGINE] [backtest] [running] [progress=${progress}%] [ticks=${tickCount}/${totalTicks}] [events_processed=${eventCount}]`);
      }
    }

    // Update pool and manager state with event (internal state management)
    pool.onSwapEvent(event);
    manager.onSwapEvent(event);
    eventCount++;
  }

  // Emit remaining ticks after all events processed
  while (currentTime <= endMs) {
    config.strategy.onTick(currentTime, createContext(currentTime));
    tickCount++;
    currentTime += config.tickIntervalMs;

    if (!config.silent && tickCount % 1000 === 0) {
      const progress = (tickCount / totalTicks * 100).toFixed(1);
      process.stdout.write(`\r[ENGINE] [backtest] [running] [progress=${progress}%] [ticks=${tickCount}/${totalTicks}] [events_processed=${eventCount}]`);
    }
  }

  if (!config.silent) {
    process.stdout.write(`\r[ENGINE] [backtest] [completed] [progress=100.0%] [ticks=${tickCount}/${totalTicks}] [events_processed=${eventCount}]       \n`);
  }

  // Finalize strategy
  config.strategy.onEnd(createContext(endMs));

  // Export performance CSVs
  if (!config.silent) {
    console.log("\n[EXPORT] [performance] [exporting]");
  }

  // Calculate performance metrics
  const fundPerformance = calculateFundPerformance(
    pool,
    manager,
    config.initialAmount0,
    config.initialAmount1
  );
  const positionPerformances = calculatePositionsPerformance(pool, manager);

  // Export to CSV
  const { fundCsvPath, positionsCsvPath } = await exportPerformanceToCSV(
    fundPerformance,
    positionPerformances,
    config.output
  );

  if (!config.silent) {
    console.log(`[EXPORT] [performance] [exported]`);
    console.log(`[OUTPUT] [fund_csv] [${fundCsvPath}]`);
    console.log(`[OUTPUT] [positions_csv] [${positionsCsvPath}]`);

    // Print summary
    console.log("\n[SUMMARY] [backtest] [results]");
    console.log(`[SUMMARY] [events.processed] [${eventCount}]`);
    console.log(`[SUMMARY] [ticks.elapsed] [${tickCount}]`);
    console.log(`[SUMMARY] [value.initial] [${fundPerformance.initialValue}] [token=${config.token1Name}]`);
    console.log(`[SUMMARY] [value.final] [${fundPerformance.totalValue}] [token=${config.token1Name}]`);
    console.log(`[SUMMARY] [pnl] [${fundPerformance.pnl}] [token=${config.token1Name}]`);
    console.log(`[SUMMARY] [roi_percent] [${fundPerformance.roiPercent.toFixed(4)}]`);
    console.log(`[SUMMARY] [fees.earned] [${fundPerformance.totalFeeEarned}] [token=${config.token1Name}]`);
    console.log("\n[COMPLETE] [backtest] [success]\n");
  }
}
