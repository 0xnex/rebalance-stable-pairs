#!/usr/bin/env bun
/**
 * Rolling Window Strategy Runner
 * 
 * Three equal-width positions that form a rolling window around the current price.
 * Only the furthest position rebalances when all are out of range.
 * 
 * Usage:
 *   bun run src/strategies/rolling_window_strategy_runner.ts [options]
 * 
 * Options:
 *   --poolId <string>         Pool ID (required)
 *   --start <ISO date>        Start date (required)
 *   --end <ISO date>          End date (required)
 *   --position-width <number> Width of each position in ticks (default: 4)
 *   --outside-duration-second <number> Seconds all positions must be out of range (default: 1800)
 *   --cooldown-second <number> Cooldown in seconds after rebalancing (default: 300)
 *   --token0 <string>         Token0 name (default: "TOKEN0")
 *   --token1 <string>         Token1 name (default: "TOKEN1")
 *   --initialAmount0 <bigint> Initial token0 amount (default: 0)
 *   --initialAmount1 <bigint> Initial token1 amount (default: 1000000000)
 *   --output <path>           Output directory (default: "./rolling-window-results")
 *   --help                    Show this help
 */

import { execute, parseBacktestArgs, type BacktestConfig } from "../backtest";
import { RollingWindowStrategy } from "./rolling_window_strategy";
import type { IStrategy } from "../types";

// ============================================================================
// Strategy-Specific CLI Parser
// ============================================================================

interface RollingWindowParams {
  positionWidth: number;
  outsideDurationMs: number;
  cooldownMs: number;
}

function parseStrategyArgs(args: string[]): RollingWindowParams {
  const params: RollingWindowParams = {
    positionWidth: 4,
    outsideDurationMs: 1800 * 1000, // 1800 seconds = 30 minutes
    cooldownMs: 300 * 1000, // 300 seconds = 5 minutes
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const next = args[i + 1];

    switch (arg) {
      case "--position-width":
      case "--width":
        if (next) {
          params.positionWidth = parseInt(next);
          i++;
        }
        break;

      case "--outside-duration-second":
        if (next) {
          params.outsideDurationMs = parseInt(next) * 1000;
          i++;
        }
        break;

      case "--cooldown-second":
        if (next) {
          params.cooldownMs = parseInt(next) * 1000;
          i++;
        }
        break;
    }
  }

  return params;
}

// ============================================================================
// Main Execution
// ============================================================================

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help")) {
    console.log(`
Rolling Window Strategy - Backtest Runner

Three equal-width positions that roll with price movement.
Only the furthest position rebalances when all are out of range.

Usage:
  bun run src/strategies/rolling_window_strategy_runner.ts [options]

Example:
  bun run src/strategies/rolling_window_strategy_runner.ts \\
    --poolId 0x7aa448e4e16d5fde0e1f12ca26826b5bc72921bea5067f6f12fd7e298e2655f9 \\
    --start "2025-08-20T00:00:00Z" \\
    --end "2025-10-10T00:00:00Z" \\
    --position-width 4 \\
    --outside-duration-second 1800 \\
    --cooldown-second 300

Strategy Options:
  --position-width <number>              Width of each position in ticks (default: 4)
  --outside-duration-second <number>     Seconds all must be out of range (default: 1800)
  --cooldown-second <number>             Cooldown after rebalancing (default: 300)

Backtest Options:
  --poolId <string>              Pool ID (required)
  --start <ISO date>             Start date (required)
  --end <ISO date>               End date (required)
  --dataDir <path>               Directory containing transaction data
  --token0Name <string>          Token0 name (default: "TOKEN0")
  --token1Name <string>          Token1 name (default: "TOKEN1")
  --decimals0 <number>           Token0 decimals (default: 8)
  --decimals1 <number>           Token1 decimals (default: 8)
  --feeTier <number>             Fee tier as percentage (default: 0.01)
  --tickSpacing <number>         Tick spacing (default: 1)
  --initialAmount0 <bigint>      Initial token0 amount (default: 0)
  --initialAmount1 <bigint>      Initial token1 amount (default: 1000000000)
  --tickIntervalMs <number>      Time tick interval in ms (default: 1000)
  --output <path>                Output directory (default: "./rolling-window-results")
    `);
    process.exit(0);
  }

  // Parse backtest configuration
  const { config: backtestConfig } = parseBacktestArgs(args);

  // Parse strategy-specific parameters
  const strategyParams = parseStrategyArgs(args);

  console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║         ROLLING WINDOW STRATEGY - Starting Backtest                   ║
╚═══════════════════════════════════════════════════════════════════════╝
`);

  console.log(`[CONFIG] [strategy] [rolling-window]`);
  console.log(`[CONFIG] [position_width] [${strategyParams.positionWidth} ticks]`);
  console.log(`[CONFIG] [outside_duration] [${strategyParams.outsideDurationMs} ms] [${strategyParams.outsideDurationMs / 1000} seconds]`);
  console.log(`[CONFIG] [cooldown] [${strategyParams.cooldownMs} ms] [${strategyParams.cooldownMs / 1000} seconds]`);

  // Create strategy with configuration
  const totalValue = (backtestConfig.initialAmount0 || 0n) + (backtestConfig.initialAmount1 || 0n);
  const initialAllocation = totalValue / 3n;

  const strategyConfig = {
    positionWidth: strategyParams.positionWidth,
    outsideDurationMs: strategyParams.outsideDurationMs,
    cooldownMs: strategyParams.cooldownMs,
    initialAllocation,
    tickSpacing: backtestConfig.tickSpacing ?? 1,
  };

  const strategy = new RollingWindowStrategy(strategyConfig);

  // Execute backtest
  await execute({
    ...backtestConfig,
    strategy,
  } as BacktestConfig & { strategy: IStrategy });
}

// Run the backtest
main().catch((error) => {
  console.error("[ERROR] Backtest failed:", error);
  process.exit(1);
});
