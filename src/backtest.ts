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

interface BacktestArgs {
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
  help: boolean;
}

function parseArgs(): BacktestArgs {
  const args = process.argv.slice(2);
  const parsed: Partial<BacktestArgs> = {
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
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--poolId":
      case "-p":
        parsed.poolId = next;
        i++;
        break;

      case "--start":
      case "-s":
        if (next) {
          parsed.startTime = new Date(next);
          i++;
        }
        break;

      case "--end":
      case "-e":
        if (next) {
          parsed.endTime = new Date(next);
          i++;
        }
        break;

      case "--initialAmount0":
      case "--init0":
        if (next) {
          parsed.initialAmount0 = BigInt(next);
          i++;
        }
        break;

      case "--initialAmount1":
      case "--init1":
        if (next) {
          parsed.initialAmount1 = BigInt(next);
          i++;
        }
        break;

      case "--token0":
        if (next) {
          parsed.token0Name = next;
          i++;
        }
        break;

      case "--token1":
        if (next) {
          parsed.token1Name = next;
          i++;
        }
        break;

      case "--decimals0":
        if (next) {
          parsed.decimals0 = parseInt(next);
          i++;
        }
        break;

      case "--decimals1":
        if (next) {
          parsed.decimals1 = parseInt(next);
          i++;
        }
        break;

      case "--dataDir":
      case "-d":
        if (next) {
          parsed.dataDir = next;
          i++;
        }
        break;

      case "--output":
      case "-o":
        if (next) {
          parsed.output = next;
          i++;
        }
        break;

      case "--tickInterval":
        if (next) {
          parsed.tickIntervalMs = parseInt(next);
          i++;
        }
        break;

      case "--tickSpacing":
        if (next) {
          parsed.tickSpacing = parseInt(next);
          i++;
        }
        break;

      case "--feeTier":
        if (next) {
          parsed.feeTier = parseInt(next);
          i++;
        }
        break;

      case "--silent":
        parsed.silent = true;
        break;

      case "--help":
      case "-h":
        parsed.help = true;
        break;

      default:
        if (arg && arg.startsWith("-")) {
          console.error(`Unknown argument: ${arg}`);
          process.exit(1);
        }
    }
  }

  if (parsed.help) {
    return parsed as BacktestArgs;
  }

  if (!parsed.poolId) {
    console.error("Error: --poolId is required");
    process.exit(1);
  }

  if (!parsed.startTime) {
    console.error("Error: --start is required");
    process.exit(1);
  }

  if (!parsed.endTime) {
    console.error("Error: --end is required");
    process.exit(1);
  }

  if (parsed.startTime >= parsed.endTime) {
    console.error("Error: --start must be before --end");
    process.exit(1);
  }

  return parsed as BacktestArgs;
}

function printHelp() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║                  BACKTEST RUNNER - Command Line Tool                  ║
╚═══════════════════════════════════════════════════════════════════════╝

USAGE:
  bun run src/backtest.ts --poolId <ID> --start <DATE> --end <DATE> [OPTIONS]

REQUIRED ARGUMENTS:
  --poolId, -p <string>      Pool ID (hex string starting with 0x)
  --start, -s <ISO date>     Start timestamp (e.g., "2025-08-20T00:00:00Z")
  --end, -e <ISO date>       End timestamp (e.g., "2025-08-21T00:00:00Z")

OPTIONAL ARGUMENTS:
  --initialAmount0 <bigint>  Initial amount of token0 (default: 10000000)
  --init0 <bigint>           Alias for --initialAmount0
  --initialAmount1 <bigint>  Initial amount of token1 (default: 10000000)
  --init1 <bigint>           Alias for --initialAmount1

  --token0 <string>          Token0 name (default: "TOKEN0")
  --token1 <string>          Token1 name (default: "TOKEN1")
  --decimals0 <int>          Token0 decimals (default: 6)
  --decimals1 <int>          Token1 decimals (default: 6)

  --dataDir, -d <path>       Events data directory (default: auto-detect)
  --output, -o <path>        Output directory (default: "./backtest-results")

  --tickSpacing <int>        Tick spacing (default: 10)
  --feeTier <int>            Fee tier in PPM (default: 3000 = 0.3%)
  --tickInterval <int>       Tick interval in ms (default: 1000 = 1 second)

  --silent                   Suppress progress logs
  --help, -h                 Show this help message

EXAMPLES:

  # Basic backtest
  bun run src/backtest.ts \\
    --poolId 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 \\
    --start "2025-08-20T00:00:00Z" \\
    --end "2025-08-21T00:00:00Z" \\
    --token0 USDC \\
    --token1 USDT

  # With custom initial balances
  bun run src/backtest.ts \\
    --poolId 0x737ec... \\
    --start "2025-08-20T00:00:00Z" \\
    --end "2025-08-21T00:00:00Z" \\
    --token0 USDC \\
    --token1 USDT \\
    --decimals0 6 \\
    --decimals1 6 \\
    --init0 50000000 \\
    --init1 50000000 \\
    --output ./results

OUTPUT:
  CSV files will be generated in the output directory:
  - fund_performance_[timestamp].csv
  - position_performance_[timestamp].csv

DOCUMENTATION:
  See PERFORMANCE_METRICS.md for CSV field descriptions
`);
}

// ============================================================================
// Backtest Engine
// ============================================================================

interface BacktestEngine {
  pool: SimplePool;
  manager: PositionManager;
  strategy?: IStrategy;
  currentTime: number;
  startTime: number;
  endTime: number;
  tickIntervalMs: number;
  silent: boolean;
}

class NoOpStrategy implements IStrategy {
  onStart(context: BacktestContext): void {}
  onEnd(context: BacktestContext): void {}
  onTick(timestamp: number, context: BacktestContext): void {}
}

async function runBacktest(args: BacktestArgs): Promise<void> {
  if (!args.silent) {
    console.log("\n[INIT] [backtest] [started]");
    console.log(`[CONFIG] [pool.id] [${args.poolId}]`);
    console.log(`[CONFIG] [token0] [${args.token0Name}] [decimals=${args.decimals0}]`);
    console.log(`[CONFIG] [token1] [${args.token1Name}] [decimals=${args.decimals1}]`);
    console.log(`[CONFIG] [period.start] [${args.startTime.toISOString()}]`);
    console.log(`[CONFIG] [period.end] [${args.endTime.toISOString()}]`);
    console.log(`[CONFIG] [period.duration_hours] [${((args.endTime.getTime() - args.startTime.getTime()) / 1000 / 60 / 60).toFixed(2)}]`);
    console.log(`[CONFIG] [initial.amount0] [${Number(args.initialAmount0)}]`);
    console.log(`[CONFIG] [initial.amount1] [${Number(args.initialAmount1)}]`);
    console.log(`[CONFIG] [tick_interval_ms] [${args.tickIntervalMs}]`);
    console.log(`[CONFIG] [output_dir] [${args.output}]`);
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
    args.token0Name,
    args.token1Name,
    args.decimals0,
    args.decimals1,
    args.feeTier,
    args.tickSpacing,
    slippageProvider
  );

  // Create position manager
  const manager = new PositionManager(args.initialAmount0, args.initialAmount1, pool);

  // ============================================================================
  // STRATEGY SELECTION
  // ============================================================================
  // To test your strategy, replace NoOpStrategy with your strategy class:
  //
  // Example:
  //   import { ExampleStrategy } from "./strategies/example_strategy";
  //   const strategy = new ExampleStrategy();
  //
  // See STRATEGY_INTEGRATION_GUIDE.md for detailed instructions
  // ============================================================================
  const strategy = new NoOpStrategy();

  // Create event generator
  if (!args.silent) {
    console.log("\n[INIT] [event_generator] [creating]");
  }

  const startMs = args.startTime.getTime();
  const endMs = args.endTime.getTime();

  const eventGenerator = createSwapEventGenerator({
    poolId: args.poolId,
    endTime: endMs,
    startTime: startMs,
    dataDir: args.dataDir,
    silent: args.silent,
  });

  if (!args.silent) {
    console.log("[ENGINE] [backtest] [starting]");
  }

  // Create backtest context for strategy
  const createContext = (currentTime: number): BacktestContext => ({
    pool,
    positionManager: manager,
    currentTime,
  });

  // Initialize strategy
  strategy.onStart(createContext(startMs));

  // Stream events and emit time ticks
  let eventCount = 0;
  let tickCount = 0;
  let currentTime = startMs;
  const totalTicks = Math.floor((endMs - startMs) / args.tickIntervalMs);
  const nextTickTime = () => currentTime + args.tickIntervalMs;

  // Process events as they stream in
  for await (const event of eventGenerator) {
    // Emit all ticks that should have occurred before this event
    while (currentTime <= endMs && event.timestamp >= nextTickTime()) {
      strategy.onTick(currentTime, createContext(currentTime));
      tickCount++;
      currentTime += args.tickIntervalMs;

      // Progress indicator
      if (!args.silent && tickCount % 1000 === 0) {
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
    strategy.onTick(currentTime, createContext(currentTime));
    tickCount++;
    currentTime += args.tickIntervalMs;

    if (!args.silent && tickCount % 1000 === 0) {
      const progress = (tickCount / totalTicks * 100).toFixed(1);
      process.stdout.write(`\r[ENGINE] [backtest] [running] [progress=${progress}%] [ticks=${tickCount}/${totalTicks}] [events_processed=${eventCount}]`);
    }
  }

  if (!args.silent) {
    process.stdout.write(`\r[ENGINE] [backtest] [completed] [progress=100.0%] [ticks=${tickCount}/${totalTicks}] [events_processed=${eventCount}]       \n`);
  }

  // Finalize strategy
  strategy.onEnd(createContext(endMs));

  // Export performance CSVs
  if (!args.silent) {
    console.log("\n[EXPORT] [performance] [exporting]");
  }

  // Calculate performance metrics
  const fundPerformance = calculateFundPerformance(
    pool,
    manager,
    args.initialAmount0,
    args.initialAmount1
  );
  const positionPerformances = calculatePositionsPerformance(pool, manager);

  // Export to CSV
  const { fundCsvPath, positionsCsvPath } = await exportPerformanceToCSV(
    fundPerformance,
    positionPerformances,
    args.output
  );

  if (!args.silent) {
    console.log(`[EXPORT] [performance] [exported]`);
    console.log(`[OUTPUT] [fund_csv] [${fundCsvPath}]`);
    console.log(`[OUTPUT] [positions_csv] [${positionsCsvPath}]`);

    // Print summary
    console.log("\n[SUMMARY] [backtest] [results]");
    console.log(`[SUMMARY] [events.processed] [${eventCount}]`);
    console.log(`[SUMMARY] [ticks.elapsed] [${tickCount}]`);
    console.log(`[SUMMARY] [value.initial] [${fundPerformance.initialValue}] [token=${args.token1Name}]`);
    console.log(`[SUMMARY] [value.final] [${fundPerformance.totalValue}] [token=${args.token1Name}]`);
    console.log(`[SUMMARY] [pnl] [${fundPerformance.pnl}] [token=${args.token1Name}]`);
    console.log(`[SUMMARY] [roi_percent] [${fundPerformance.roiPercent.toFixed(4)}]`);
    console.log(`[SUMMARY] [fees.earned] [${fundPerformance.totalFeeEarned}] [token=${args.token1Name}]`);
    console.log("\n[COMPLETE] [backtest] [success]\n");
  }
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
  const args = parseArgs();

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  try {
    await runBacktest(args);
    process.exit(0);
  } catch (error) {
    console.error("\n[ERROR] [backtest] [failed]");
    console.error(`[ERROR] [message] [${error instanceof Error ? error.message : String(error)}]`);
    if (error instanceof Error && error.stack) {
      console.error(`[ERROR] [stack] [${error.stack}]`);
    }
    process.exit(1);
  }
}

// Run if executed directly
if (import.meta.main) {
  main();
}

export { parseArgs, runBacktest };
