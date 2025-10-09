import { parseArgs } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { BacktestEngine, type BacktestStrategy } from "./backtest_engine";
import { Pool } from "./pool";

type StrategyModule = {
  default?: StrategyFactory;
  strategyFactory?: StrategyFactory;
};

type StrategyFactory = (pool: Pool) => BacktestStrategy;

async function main() {
  const {
    values: { poolId, start, end, step, dataDir, strategy: strategyPath },
  } = parseArgs({
    options: {
      poolId: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      step: { type: "string" },
      dataDir: { type: "string" },
      strategy: { type: "string" },
    },
  });

  if (!poolId) {
    throw new Error("--poolId is required");
  }
  if (!start || !end) {
    throw new Error("--start and --end ISO timestamp strings are required");
  }
  if (!strategyPath) {
    throw new Error("--strategy path is required");
  }

  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    throw new Error("Invalid start or end timestamp");
  }

  const stepMs = step ? Number(step) : 1000;
  if (!Number.isFinite(stepMs) || stepMs <= 0) {
    throw new Error("--step must be a positive number (milliseconds)");
  }

  const resolvedStrategy = path.isAbsolute(strategyPath)
    ? strategyPath
    : path.join(process.cwd(), strategyPath);
  const modUrl = pathToFileURL(resolvedStrategy).href;
  const mod: StrategyModule = await import(modUrl);
  const factory = mod.strategyFactory ?? mod.default;
  if (typeof factory !== "function") {
    throw new Error(
      `Strategy module must export a default function or strategyFactory(pool) => strategy`
    );
  }

  const inferredDataDir = dataDir
    ? path.resolve(process.cwd(), dataDir)
    : path.resolve(__dirname, "../mmt_txs", poolId);

  const engine = new BacktestEngine({
    poolId,
    startTime,
    endTime,
    stepMs,
    dataDir: inferredDataDir,
    strategyFactory: factory,
    logger: console,
  });

  const report = await engine.run();

  console.log("\nBacktest complete");
  const json = JSON.stringify(
    report,
    (_key, value) => (typeof value === "bigint" ? value.toString() : value),
    2
  );
  console.log(json);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
