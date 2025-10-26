#!/usr/bin/env bun
/**
 * Three-Band Pyramid Strategy Runner
 * 
 * This script demonstrates how to run a backtest with custom strategy configuration
 * without modifying the core backtest.ts file.
 * 
 * Usage:
 *   bun run src/strategies/three_band_pyramid_strategy_runner.ts [options]
 * 
 * Options:
 *   --poolId <string>         Pool ID (required)
 *   --start <ISO date>        Start date (required)
 *   --end <ISO date>          End date (required)
 *   --band1-width <number>    Band 1 width in ticks (default: 2)
 *   --band2-width <number>    Band 2 width in ticks (default: 4)
 *   --band3-width <number>    Band 3 width in ticks (default: 8)
 *   --band1-alloc <number>    Band 1 allocation % (default: 30)
 *   --band2-alloc <number>    Band 2 allocation % (default: 30)
 *   --band3-alloc <number>    Band 3 allocation % (default: 40)
 *   --outside-duration <number> Duration outside Band 3 in minutes (default: 30)
 *   --cooldown <number>       Cooldown between rebalances in minutes (default: 5)
 *   --token0 <string>         Token0 name (default: "USDC")
 *   --token1 <string>         Token1 name (default: "USDT")
 *   --init0 <bigint>          Initial token0 amount (default: 10000000)
 *   --init1 <bigint>          Initial token1 amount (default: 10000000)
 *   --output <path>           Output directory (default: "./three-band-results")
 *   --silent                  Suppress logs
 *   --help                    Show this help
 */

import { execute, parseBacktestArgs, type BacktestConfig } from "../backtest";
import { ThreeBandPyramidStrategy } from "./three_band_pyramid_strategy";
import type { ThreeBandConfig } from "./three_band_pyramid_strategy";

// ============================================================================
// Strategy-Specific CLI Parser
// ============================================================================

interface ThreeBandParams {
  band1Width: number;
  band2Width: number;
  band3Width: number;
  band1Allocation: number;
  band2Allocation: number;
  band3Allocation: number;
  outsideDurationMs: number;
  cooldownMs: number;
}

function parseStrategyArgs(args: string[]): ThreeBandParams {
  const params: ThreeBandParams = {
    band1Width: 2,
    band2Width: 4,
    band3Width: 8,
    band1Allocation: 30,
    band2Allocation: 30,
    band3Allocation: 40,
    outsideDurationMs: 30 * 60 * 1000,
    cooldownMs: 5 * 60 * 1000,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--band1-width":
        if (next) {
          params.band1Width = parseFloat(next);
          i++;
        }
        break;

      case "--band2-width":
        if (next) {
          params.band2Width = parseFloat(next);
          i++;
        }
        break;

      case "--band3-width":
        if (next) {
          params.band3Width = parseFloat(next);
          i++;
        }
        break;

      case "--band1-alloc":
        if (next) {
          params.band1Allocation = parseFloat(next);
          i++;
        }
        break;

      case "--band2-alloc":
        if (next) {
          params.band2Allocation = parseFloat(next);
          i++;
        }
        break;

      case "--band3-alloc":
        if (next) {
          params.band3Allocation = parseFloat(next);
          i++;
        }
        break;

      case "--outside-duration":
        if (next) {
          params.outsideDurationMs = parseFloat(next) * 60 * 1000; // minutes to ms
          i++;
        }
        break;

      case "--cooldown":
        if (next) {
          params.cooldownMs = parseFloat(next) * 60 * 1000; // minutes to ms
          i++;
        }
        break;

      default:
        // Ignore unknown args (already handled by backtest parser)
        if (next && !next.startsWith("-")) {
          i++;
        }
    }
  }

  return params;
}

function printHelp() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║         THREE-BAND PYRAMID STRATEGY - Backtest Runner                 ║
╚═══════════════════════════════════════════════════════════════════════╝

USAGE:
  bun run src/strategies/three_band_pyramid_strategy_runner.ts --poolId <ID> --start <DATE> --end <DATE> [OPTIONS]

REQUIRED ARGUMENTS:
  --poolId, -p <string>      Pool ID (hex string starting with 0x)
  --start, -s <ISO date>     Start timestamp (e.g., "2025-08-20T00:00:00Z")
  --end, -e <ISO date>       End timestamp (e.g., "2025-08-21T00:00:00Z")

STRATEGY CONFIGURATION:
  --band1-width <number>     Width of Band 1 in ticks (default: 2)
  --band2-width <number>     Width of Band 2 in ticks (default: 4)
  --band3-width <number>     Width of Band 3 in ticks (default: 8)
  --band1-alloc <number>     Band 1 allocation percentage (default: 30)
  --band2-alloc <number>     Band 2 allocation percentage (default: 30)
  --band3-alloc <number>     Band 3 allocation percentage (default: 40)
  --outside-duration <num>   Minutes outside Band 3 before rebalance (default: 30)
  --cooldown <number>        Minutes between rebalances (default: 5)

BACKTEST CONFIGURATION:
  --token0 <string>          Token0 name (default: "TOKEN0")
  --token1 <string>          Token1 name (default: "TOKEN1")
  --init0 <bigint>           Initial token0 amount (default: 10000000)
  --init1 <bigint>           Initial token1 amount (default: 10000000)
  --decimals0 <int>          Token0 decimals (default: 6)
  --decimals1 <int>          Token1 decimals (default: 6)
  --output, -o <path>        Output directory (default: "./backtest-results")
  --dataDir, -d <path>       Events data directory (default: auto-detect)
  --tickSpacing <int>        Tick spacing (default: 10)
  --feeTier <int>            Fee tier in PPM (default: 3000)
  --tickInterval <int>       Tick interval in ms (default: 1000)
  --silent                   Suppress progress logs
  --help, -h                 Show this help message

EXAMPLES:

  # Basic run with defaults
  bun run src/strategies/three_band_pyramid_strategy_runner.ts \\
    --poolId 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 \\
    --start "2025-08-20T00:00:00Z" \\
    --end "2025-08-21T00:00:00Z"

  # Custom configuration
  bun run src/strategies/three_band_pyramid_strategy_runner.ts \\
    --poolId 0x737ec... \\
    --start "2025-08-20T00:00:00Z" \\
    --end "2025-08-21T00:00:00Z" \\
    --band1-width 1 \\
    --band2-width 3 \\
    --band3-width 10 \\
    --outside-duration 60 \\
    --cooldown 10 \\
    --token0 USDC \\
    --token1 USDT

OUTPUT:
  CSV files will be generated in the output directory:
  - fund_performance_[timestamp].csv
  - position_performance_[timestamp].csv

DOCUMENTATION:
  See THREE_BAND_STRATEGY_GUIDE.md for strategy details
  See PERFORMANCE_METRICS.md for CSV field descriptions
`);
}

// ============================================================================
// Main Runner
// ============================================================================

async function main() {
  // Parse common backtest arguments
  const { config, unparsedArgs, help } = parseBacktestArgs();

  if (help) {
    printHelp();
    process.exit(0);
  }

  // Parse strategy-specific arguments
  const strategyParams = parseStrategyArgs(unparsedArgs);

  console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║         THREE-BAND PYRAMID STRATEGY - Starting Backtest               ║
╚═══════════════════════════════════════════════════════════════════════╝
`);

  console.log("[CONFIG] [strategy] [three-band-pyramid]");
  console.log(`[CONFIG] [band_widths] [${strategyParams.band1Width},${strategyParams.band2Width},${strategyParams.band3Width}]`);
  console.log(`[CONFIG] [allocations] [${strategyParams.band1Allocation}%,${strategyParams.band2Allocation}%,${strategyParams.band3Allocation}%]`);
  console.log(`[CONFIG] [outside_duration] [${strategyParams.outsideDurationMs} ms] [${(strategyParams.outsideDurationMs / 60000).toFixed(2)} minutes]`);
  console.log(`[CONFIG] [cooldown] [${strategyParams.cooldownMs} ms] [${(strategyParams.cooldownMs / 60000).toFixed(2)} minutes]`);

  // Create strategy with configuration
  const strategyConfig: Partial<ThreeBandConfig> = {
    band1Width: strategyParams.band1Width,
    band2Width: strategyParams.band2Width,
    band3Width: strategyParams.band3Width,
    band1Allocation: strategyParams.band1Allocation,
    band2Allocation: strategyParams.band2Allocation,
    band3Allocation: strategyParams.band3Allocation,
    outsideDurationMs: strategyParams.outsideDurationMs,
    cooldownMs: strategyParams.cooldownMs,
    tickSpacing: config.tickSpacing ?? 10,
  };

  const strategy = new ThreeBandPyramidStrategy(strategyConfig);

  try {
    // Execute backtest with complete configuration
    await execute({
      strategy,
      poolId: config.poolId!,
      startTime: config.startTime!,
      endTime: config.endTime!,
      token0Name: config.token0Name ?? "TOKEN0",
      token1Name: config.token1Name ?? "TOKEN1",
      decimals0: config.decimals0 ?? 6,
      decimals1: config.decimals1 ?? 6,
      initialAmount0: config.initialAmount0 ?? 10_000_000n,
      initialAmount1: config.initialAmount1 ?? 10_000_000n,
      dataDir: config.dataDir,
      output: config.output ?? "./backtest-results",
      tickSpacing: config.tickSpacing ?? 10,
      feeTier: config.feeTier ?? 3000,
      tickIntervalMs: config.tickIntervalMs ?? 1000,
      silent: config.silent ?? false,
    });

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

// Run
main();
