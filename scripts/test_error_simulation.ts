/**
 * Test Script: Error Simulation
 *
 * Demonstrates the simulateErrors feature that causes position creation
 * to fail N-1 times before succeeding on the Nth attempt.
 */

import { BacktestEngine } from "../src/backtest_engine";
import type { BacktestStrategy, StrategyContext } from "../src/backtest_engine";

// Strategy that creates multiple positions with error handling
class ErrorSimulationStrategy implements BacktestStrategy {
  readonly id = "error-simulation-test";
  private positionIds = ["pos-1", "pos-2", "pos-3"];
  private successfulCreations = 0;
  private failedAttempts = 0;

  onInit(ctx: StrategyContext): void {
    console.log(`\n[${this.id}] Starting error simulation test`);
    console.log(
      `Initial capital: ${ctx.manager.amount0} / ${ctx.manager.amount1}`
    );
    console.log(`Pool price: ${ctx.pool.price.toFixed(6)}\n`);

    // Try to create 3 positions
    for (const posId of this.positionIds) {
      this.tryCreatePosition(ctx, posId);
    }

    console.log(`\n[${this.id}] Initialization complete`);
    console.log(`  Successful creations: ${this.successfulCreations}`);
    console.log(`  Failed attempts: ${this.failedAttempts}`);
  }

  private tryCreatePosition(
    ctx: StrategyContext,
    posId: string,
    maxAttempts = 10
  ): void {
    const currentTick = ctx.pool.tickCurrent;
    const tickLower = currentTick - 10;
    const tickUpper = currentTick + 10;
    const amount0 = 1000_00000000n; // 1000 tokens
    const amount1 = 1000_00000000n;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        console.log(
          `\n[${this.id}] Attempting to create position ${posId} (attempt ${attempt})...`
        );

        const position = ctx.manager.createPosition(
          posId,
          tickLower,
          tickUpper,
          amount0,
          amount1,
          ctx.timestamp
        );

        console.log(
          `[${this.id}] ✅ SUCCESS! Position ${posId} created with liquidity: ${position.liquidity}`
        );
        this.successfulCreations++;
        return; // Success, exit retry loop
      } catch (error: any) {
        console.log(`[${this.id}] ❌ FAILED: ${error.message}`);
        this.failedAttempts++;

        // Check if this is a simulated error (should retry) or real error (should stop)
        if (!error.message.includes("Simulated")) {
          console.log(
            `[${this.id}] Real error encountered, stopping retries for ${posId}`
          );
          return;
        }
      }
    }

    console.log(`[${this.id}] ⚠️  Max attempts reached for position ${posId}`);
  }

  onTick(ctx: StrategyContext): void {
    // No-op for this test
  }

  onFinish(ctx: StrategyContext): void {
    console.log(`\n[${this.id}] Test complete!`);
    console.log(`  Total successful creations: ${this.successfulCreations}`);
    console.log(`  Total failed attempts: ${this.failedAttempts}`);

    // Show final state
    const totals = ctx.manager.getTotals();
    console.log(`\n[${this.id}] Final state:`);
    console.log(`  Open positions: ${totals.positions}`);
    console.log(
      `  Remaining cash: ${totals.cashAmountA} / ${totals.cashAmountB}`
    );
  }
}

async function main() {
  console.log("=== Error Simulation Test ===\n");

  // Test different error simulation settings
  const testCases = [
    { simulateErrors: 0, description: "No errors (control)" },
    { simulateErrors: 2, description: "Fail once, succeed on 2nd attempt" },
    { simulateErrors: 3, description: "Fail twice, succeed on 3rd attempt" },
    { simulateErrors: 5, description: "Fail 4 times, succeed on 5th attempt" },
  ];

  for (const testCase of testCases) {
    console.log(`\n${"=".repeat(60)}`);
    console.log(`TEST: ${testCase.description}`);
    console.log(`simulateErrors = ${testCase.simulateErrors}`);
    console.log("=".repeat(60));

    const engine = new BacktestEngine({
      poolId:
        "0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9",
      startTime: new Date("2025-08-20T00:00:00Z").getTime(),
      endTime: new Date("2025-08-20T00:01:00Z").getTime(), // Just 1 minute
      decimals0: 8,
      decimals1: 8,
      feeRatePpm: 100,
      tickSpacing: 2,
      stepMs: 60_000, // 1 minute steps
      dataDir:
        "../mmt_txs/0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9",
      invest0: 5000_00000000n,
      invest1: 5000_00000000n,
      strategyFactory: () => new ErrorSimulationStrategy(),
      logger: { log: () => {} }, // Suppress engine logs for cleaner output
      simulateErrors: testCase.simulateErrors, // KEY PARAMETER
    });

    try {
      await engine.run();
    } catch (error) {
      console.error("Engine error:", error);
    }

    console.log(`\nExpected behavior:`);
    if (testCase.simulateErrors === 0) {
      console.log(`  • All 3 positions should be created on first attempt`);
      console.log(`  • Total attempts: 3, Failures: 0`);
    } else {
      const failuresPerPosition = testCase.simulateErrors - 1;
      const totalFailures = failuresPerPosition * 3;
      console.log(
        `  • Each position should fail ${failuresPerPosition} time(s) before succeeding`
      );
      console.log(
        `  • Total attempts: ${
          testCase.simulateErrors * 3
        }, Failures: ${totalFailures}`
      );
    }
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log("All tests completed!");
  console.log("=".repeat(60));
}

main().catch(console.error);
