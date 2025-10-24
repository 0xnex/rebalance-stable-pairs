#!/usr/bin/env bun

/**
 * Example backtest script showing how to test a strategy
 * 
 * Usage:
 *   bun run scripts/run_example_strategy.ts
 */

// Change the working directory and import from src
import { ExampleStrategy } from "../src/strategies/example_strategy";
import type { IStrategy } from "../src/types";

console.log(`
╔══════════════════════════════════════════════════════════════╗
║           EXAMPLE STRATEGY BACKTEST                          ║
╚══════════════════════════════════════════════════════════════╝

This script demonstrates how to test a strategy.

To use this pattern:
1. Import your strategy class
2. Update the configuration below
3. Run: bun run scripts/run_example_strategy.ts

For production use, you should:
- Add CLI argument parsing
- Support multiple strategies
- Add configuration files
`);

// To actually run the backtest, you need to:
// 1. Import the runBacktest function (need to export it from backtest.ts)
// 2. Pass the strategy instance

console.log(`
To integrate your strategy:
1. Edit src/backtest.ts
2. Replace this line:
   const strategy = new NoOpStrategy();
   
   With:
   import { ExampleStrategy } from "./strategies/example_strategy";
   const strategy = new ExampleStrategy();

3. Run backtest:
   bun run src/backtest.ts \\
     --poolId 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 \\
     --start "2025-08-20T00:00:00Z" \\
     --end "2025-08-21T00:00:00Z" \\
     --token0 USDC \\
     --token1 USDT
`);

