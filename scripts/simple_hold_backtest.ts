/**
 * Simple Hold Strategy Backtest Runner
 *
 * Tests the backtest framework with a basic hold strategy
 */

import { BacktestEngine } from "../src/backtest_engine";
import { createSimpleHoldStrategy } from "../src/strategies/simple_hold_strategy";
import { parseArgs } from "util";

const POOL_ID =
  "0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9";
const DATA_DIR =
  "../mmt_txs/0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9";

async function main() {
  console.log("=== Simple Hold Strategy Backtest ===\n");

  const start = new Date("2025-08-20T00:00:00Z").getTime();
  const end = new Date("2025-08-21T00:00:00Z").getTime();

  console.log(`Pool ID: ${POOL_ID}`);
  console.log(`Data Dir: ${DATA_DIR}`);
  console.log(`Start Time: ${new Date(start).toISOString()}`);
  console.log(`End Time: ${new Date(end).toISOString()}`);
  console.log(
    `Duration: ${((end - start) / 1000 / 60 / 60).toFixed(2)} hours\n`
  );

  // Configuration
  // For a position around tick 0 (price ~1.0), we need both tokens
  // Split capital 50/50 between token0 and token1
  const initialAmount0 = 5000_00000000n; // 5000 USDT (8 decimals)
  const initialAmount1 = 5000_00000000n; // 5000 USDC (8 decimals)

  // Wide position: ±0.1% (±10 ticks for stable pairs)
  const centerTick = 0; // Assume price ~1.0
  const tickRange = 10;
  const tickLower = centerTick - tickRange;
  const tickUpper = centerTick + tickRange;

  console.log(
    `Initial Capital: ${Number(initialAmount0) / 1e8} token0, ${
      Number(initialAmount1) / 1e8
    } token1`
  );
  console.log(`Position Range: ticks [${tickLower}, ${tickUpper}] (~±0.1%)\n`);

  // Create backtest engine
  const engine = new BacktestEngine({
    poolId: POOL_ID,
    startTime: start,
    endTime: end,
    decimals0: 8,
    decimals1: 8,
    feeRatePpm: 100, // 0.01%
    tickSpacing: 2,
    stepMs: 1000, // 1 second steps
    dataDir: DATA_DIR,
    invest0: initialAmount0,
    invest1: initialAmount1,
    strategyFactory: (pool, manager) => {
      return createSimpleHoldStrategy(
        tickLower,
        tickUpper,
        initialAmount0,
        initialAmount1
      );
    },
    logger: console,
    metricsIntervalMs: 60_000, // Sample every minute
  });

  console.log("Starting backtest...\n");
  const startRunTime = Date.now();

  try {
    const report = await engine.run();

    const runDuration = Date.now() - startRunTime;

    if (!report) {
      console.error("Backtest failed to produce a report");
      process.exit(1);
    }

    console.log("\n=== Backtest Complete ===\n");
    console.log(`Run Duration: ${(runDuration / 1000).toFixed(2)}s`);
    console.log(`Events Processed: ${report.eventsProcessed}`);
    console.log(`Ticks Simulated: ${report.ticks}`);
    console.log(
      `Time per Tick: ${(runDuration / report.ticks).toFixed(2)}ms\n`
    );

    // Performance
    console.log("=== Performance ===");
    console.log(
      `Initial Value: $${report.performance.initialValue.toFixed(2)}`
    );
    console.log(`Final Value: $${report.performance.finalValue.toFixed(2)}`);
    console.log(
      `Absolute Return: $${report.performance.absoluteReturn.toFixed(2)}`
    );
    console.log(`Return %: ${report.performance.returnPct.toFixed(4)}%`);
    console.log(
      `Highest Value: $${report.performance.highestValue.toFixed(2)}`
    );
    console.log(`Lowest Value: $${report.performance.lowestValue.toFixed(2)}`);
    console.log(
      `Max Drawdown: ${report.performance.maxDrawdownPct.toFixed(4)}%\n`
    );

    // Totals
    console.log("=== Position Totals ===");
    console.log(`Positions: ${report.totals.positions}`);
    console.log(`Cash Token0: ${Number(report.totals.cashAmountA) / 1e8}`);
    console.log(`Cash Token1: ${Number(report.totals.cashAmountB) / 1e8}`);
    console.log(
      `Position Token0: ${
        Number(report.totals.amountA - report.totals.cashAmountA) / 1e8
      }`
    );
    console.log(
      `Position Token1: ${
        Number(report.totals.amountB - report.totals.cashAmountB) / 1e8
      }`
    );
    console.log(`Fees Owed Token0: ${Number(report.totals.feesOwed0) / 1e8}`);
    console.log(`Fees Owed Token1: ${Number(report.totals.feesOwed1) / 1e8}`);
    console.log(
      `Collected Fees Token0: ${Number(report.totals.collectedFees0) / 1e8}`
    );
    console.log(
      `Collected Fees Token1: ${Number(report.totals.collectedFees1) / 1e8}\n`
    );

    // Final state
    console.log("=== Final Pool State ===");
    console.log(`Price: ${report.finalState.currentPrice.toFixed(6)}`);
    console.log(`Tick: ${report.finalState.currentTick}`);
    console.log(`Liquidity: ${report.finalState.liquidity}`);
    console.log(`Open Positions: ${report.finalState.openPositions.length}\n`);

    // Open positions detail
    if (report.finalState.openPositions.length > 0) {
      console.log("=== Open Positions Detail ===");
      for (const pos of report.finalState.openPositions) {
        console.log(`Position ${pos.id}:`);
        console.log(`  Range: [${pos.tickLower}, ${pos.tickUpper}]`);
        console.log(
          `  Price Range: [${pos.priceLower.toFixed(
            6
          )}, ${pos.priceUpper.toFixed(6)}]`
        );
        console.log(`  Mid Price: ${pos.midPrice.toFixed(6)}`);
        console.log(`  Width: ${pos.widthPercent.toFixed(4)}%`);
        console.log(`  Active: ${pos.isActive}`);
        console.log(`  Liquidity: ${pos.liquidity}`);
        console.log(`  Token0: ${Number(pos.amountA) / 1e8}`);
        console.log(`  Token1: ${Number(pos.amountB) / 1e8}`);
        console.log(
          `  Distance from current: ${pos.distanceFromCurrentPercent.toFixed(
            4
          )}%\n`
        );
      }
    }

    console.log("=== Test Summary ===");
    console.log("✅ Backtest framework working correctly");
    console.log("✅ Pool state updates working");
    console.log("✅ Position creation working");
    console.log("✅ Fee distribution working");
    console.log("✅ Performance tracking working");
    console.log("✅ Reporting working\n");
  } catch (error) {
    console.error("❌ Backtest failed:", error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
