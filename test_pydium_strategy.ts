import * as fs from "fs";
import path from "path";
import { parseArgs } from "util";
import { BacktestEngine } from "./src/backtest_engine";
import { strategyFactory as pydiumStrategyFactory } from "./src/strategies/three_band_pydium_backtest";
import {
  type MomentumEventPage,
  type Transaction,
  type MomentumEvent,
} from "./src/event_importer";

const SwapEvent =
  "0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::trade::SwapEvent";
const RepayFlashSwapEvent =
  "0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::trade::RepayFlashSwapEvent";

const {
  values: { dataDir, poolId },
} = parseArgs({
  options: {
    dataDir: { type: "string", default: "../mmt_txs" },
    poolId: {
      type: "string",
      default:
        "0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9",
    },
  },
});

async function main() {
  console.log("Starting Pydium Three-Band Strategy Backtest");
  console.log(`Pool ID: ${poolId}`);
  console.log(`Data Directory: ${dataDir}`);

  const dir = path.join(dataDir, poolId);
  if (!fs.existsSync(dir)) {
    throw new Error(`Data directory does not exist: ${dir}`);
  }

  let files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort(); // Process files in order

  console.log(`Found ${files.length} data files to process`);

  // Create backtest engine
  const engine = new BacktestEngine();
  const strategy = pydiumStrategyFactory(engine.pool);

  // Add strategy to engine
  engine.addStrategy(strategy);

  // Process all transaction files
  for (const file of files) {
    const filePath = path.join(dir, file);
    console.log(`Processing ${filePath}`);

    const data = JSON.parse(
      fs.readFileSync(filePath, "utf-8")
    ) as MomentumEventPage;
    const transactions = data.data;

    for (const tx of transactions) {
      const events = tx.events;
      for (let i = 0; i < events.length; i++) {
        const ev = events[i] as MomentumEvent;
        if (ev.type !== SwapEvent && ev.type !== RepayFlashSwapEvent) {
          continue;
        }

        if (ev?.parsedJson.pool_id?.toLowerCase() !== poolId.toLowerCase()) {
          continue;
        }

        const type = ev.type;
        if (type === SwapEvent) {
          let isFlashSwap = false;
          let isSameToken = false;
          if (i < events.length - 1) {
            const nextEv = events[i + 1] as MomentumEvent;
            if (nextEv.type === RepayFlashSwapEvent) {
              isFlashSwap = true;
              isSameToken =
                nextEv.parsedJson.paid_x === ev.parsedJson.amount_x_debt &&
                nextEv.parsedJson.paid_y === ev.parsedJson.amount_y_debt;
            }
          }

          // Add event to backtest engine
          engine.addEvent({
            timestampMs: BigInt(tx.timestampMs),
            amount_x: BigInt(ev.parsedJson.amount_x),
            amount_y: BigInt(ev.parsedJson.amount_y),
            fee_amount: BigInt(ev.parsedJson.fee_amount),
            liquidity: BigInt(ev.parsedJson.liquidity),
            sqrt_price_before: BigInt(ev.parsedJson.sqrt_price_before),
            sqrt_price_after: BigInt(ev.parsedJson.sqrt_price_after),
            x_for_y: ev.parsedJson.x_for_y,
            tick_index: ev.parsedJson.tick_index,
            txDigest: tx.digest,
            isFlashSwap,
            isSameToken,
          });
        }
      }
    }
  }

  // Run the backtest
  console.log("Running backtest...");
  const results = await engine.run();

  console.log("\n=== BACKTEST RESULTS ===");
  console.log(`Total events processed: ${results.totalEvents}`);
  console.log(`Backtest duration: ${results.duration}ms`);
  console.log(`Final pool tick: ${results.finalTick}`);
  console.log(`Final pool price: ${results.finalPrice.toFixed(6)}`);

  // Get strategy-specific results
  const strategyResults = results.strategies.find(
    (s) => s.id === "three-band-pydium"
  );
  if (strategyResults) {
    console.log(`\n=== PYDIUM STRATEGY RESULTS ===`);
    console.log(`Strategy ID: ${strategyResults.id}`);
    console.log(`Total PnL: ${strategyResults.totalPnL}`);
    console.log(`Total fees collected: ${strategyResults.totalFeesCollected}`);
    console.log(`Total costs: ${strategyResults.totalCosts}`);
    console.log(`Net return: ${strategyResults.netReturn}`);
  }

  console.log("\nBacktest completed successfully!");
}

main().catch((error) => {
  console.error("Backtest failed:", error);
  process.exit(1);
});
