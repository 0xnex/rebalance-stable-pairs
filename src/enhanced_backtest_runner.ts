#!/usr/bin/env bun
/**
 * Enhanced Backtest Runner with improved fee calculation and detailed reporting
 */

import { parseArgs } from "node:util";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as fs from "fs";
import { BacktestEngine, type BacktestStrategy } from "./backtest_engine";
import { Pool } from "./pool";
import { EnhancedFeeCalculator } from "./enhanced_fee_calculator";
import { ReportGenerator } from "./report_generator";

type StrategyModule = {
  default?: StrategyFactory;
  strategyFactory?: StrategyFactory;
};

type StrategyFactory = (pool: Pool) => BacktestStrategy;

interface EnhancedBacktestConfig {
  poolId: string;
  startTime: number;
  endTime: number;
  stepMs: number;
  dataDir: string;
  strategyPath: string;
  initialInvestment: number;
  tradingPair: string;
  outputFormat: "json" | "table" | "both" | "csv";
  outputFile?: string;
  enableEnhancedFees: boolean;
  enableDetailedReport: boolean;
  streamCsv: boolean; // Stream CSV instead of building JSON in memory
}

async function main() {
  const {
    values: {
      poolId,
      start,
      end,
      step,
      dataDir,
      strategy: strategyPath,
      investment,
      pair,
      format,
      output,
      enhancedFees,
      detailedReport,
      tokenAName,
      tokenADecimals,
      tokenBName,
      tokenBDecimals,
      feeRatePpm,
      tickSpacing,
    },
  } = parseArgs({
    options: {
      poolId: { type: "string" },
      start: { type: "string" },
      end: { type: "string" },
      step: { type: "string" },
      dataDir: { type: "string" }, // Query database if not provided
      strategy: { type: "string" },
      investment: { type: "string" },
      pair: { type: "string" },
      format: { type: "string" },
      output: { type: "string" },
      enhancedFees: { type: "boolean" },
      detailedReport: { type: "boolean" },
      tokenAName: { type: "string" },
      tokenADecimals: { type: "string" },
      tokenBName: { type: "string" },
      tokenBDecimals: { type: "string" },
      feeRatePpm: { type: "string" },
      tickSpacing: { type: "string" },
    },
  });

  // Validate required parameters
  if (!poolId) {
    throw new Error("--poolId is required");
  }
  if (!start || !end) {
    throw new Error("--start and --end ISO timestamp strings are required");
  }
  if (!strategyPath) {
    throw new Error("--strategy path is required");
  }

  // Parse and validate inputs
  const startTime = Date.parse(start);
  const endTime = Date.parse(end);
  if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
    throw new Error("Invalid start or end timestamp");
  }

  const stepMs = step ? Number(step) : 1000;
  if (!Number.isFinite(stepMs) || stepMs <= 0) {
    throw new Error("--step must be a positive number (milliseconds)");
  }

  const config: EnhancedBacktestConfig = {
    poolId,
    startTime,
    endTime,
    stepMs,
    dataDir: dataDir ? path.resolve(process.cwd(), dataDir) : "",
    strategyPath: path.isAbsolute(strategyPath)
      ? strategyPath
      : path.join(process.cwd(), strategyPath),
    initialInvestment: investment ? parseFloat(investment) : 100000,
    tradingPair: pair || "SUI/USDC",
    outputFormat: (format as "json" | "table" | "both" | "csv") || "csv",
    outputFile: output,
    enableEnhancedFees: enhancedFees !== false,
    enableDetailedReport: detailedReport !== false,
    streamCsv: format !== "json" && format !== "both", // Stream CSV by default unless JSON explicitly requested
  };

  console.log(`🚀 Starting Enhanced Backtest...`);
  console.log(`📊 Pool: ${config.poolId}`);
  console.log(
    `📅 Period: ${new Date(startTime).toISOString()} → ${new Date(
      endTime
    ).toISOString()}`
  );
  console.log(
    `💰 Initial Investment: $${config.initialInvestment.toLocaleString()}`
  );
  console.log(
    `⚡ Enhanced Fees: ${config.enableEnhancedFees ? "Enabled" : "Disabled"}`
  );
  console.log(
    `📋 Detailed Report: ${
      config.enableDetailedReport ? "Enabled" : "Disabled"
    }`
  );

  // Load strategy
  const modUrl = pathToFileURL(config.strategyPath).href;
  const mod: StrategyModule = await import(modUrl);
  const factory = mod.strategyFactory ?? mod.default;
  if (typeof factory !== "function") {
    throw new Error(
      `Strategy module must export a default function or strategyFactory(pool) => strategy`
    );
  }

  // Set token metadata as environment variables
  const tokenMetadata = {
    tokenAName: tokenAName || process.env.TOKEN_A_NAME || "TokenA",
    tokenADecimals: tokenADecimals
      ? parseInt(tokenADecimals)
      : process.env.TOKEN_A_DECIMALS
      ? parseInt(process.env.TOKEN_A_DECIMALS)
      : 9,
    tokenBName: tokenBName || process.env.TOKEN_B_NAME || "TokenB",
    tokenBDecimals: tokenBDecimals
      ? parseInt(tokenBDecimals)
      : process.env.TOKEN_B_DECIMALS
      ? parseInt(process.env.TOKEN_B_DECIMALS)
      : 9,
  };

  // Read initial amounts from environment variables (with proper decimals)
  const initialAmountA = process.env.THREEBAND_INITIAL_A
    ? BigInt(process.env.THREEBAND_INITIAL_A)
    : 0n;
  const initialAmountB = process.env.THREEBAND_INITIAL_B
    ? BigInt(process.env.THREEBAND_INITIAL_B)
    : BigInt(config.initialInvestment); // Fallback to CLI investment

  // Parse fee rate and tick spacing from CLI or environment
  const poolFeeRatePpm = feeRatePpm
    ? parseInt(feeRatePpm)
    : process.env.POOL_FEE_RATE_PPM
    ? parseInt(process.env.POOL_FEE_RATE_PPM)
    : 100;
  const poolTickSpacing = tickSpacing
    ? parseInt(tickSpacing)
    : process.env.POOL_TICK_SPACING
    ? parseInt(process.env.POOL_TICK_SPACING)
    : 2;

  process.env.TOKEN_A_NAME = tokenMetadata.tokenAName;
  process.env.TOKEN_A_DECIMALS = tokenMetadata.tokenADecimals.toString();
  process.env.TOKEN_B_NAME = tokenMetadata.tokenBName;
  process.env.TOKEN_B_DECIMALS = tokenMetadata.tokenBDecimals.toString();
  process.env.TRADING_PAIR = config.tradingPair;
  process.env.INITIAL_INVESTMENT = config.initialInvestment.toString();

  // Convert to human-readable for display
  const displayAmountA =
    Number(initialAmountA) / Math.pow(10, tokenMetadata.tokenADecimals);
  const displayAmountB =
    Number(initialAmountB) / Math.pow(10, tokenMetadata.tokenBDecimals);

  console.log(`\n💱 Token Configuration:`);
  console.log(
    `   Token A: ${tokenMetadata.tokenAName} (${tokenMetadata.tokenADecimals} decimals)`
  );
  console.log(
    `   Token B: ${tokenMetadata.tokenBName} (${tokenMetadata.tokenBDecimals} decimals)`
  );
  console.log(`   Quote Currency: ${tokenMetadata.tokenBName}`);
  console.log(`\n💰 Initial Investment:`);
  console.log(
    `   Token A: ${displayAmountA.toLocaleString()} ${
      tokenMetadata.tokenAName
    } (raw: ${initialAmountA})`
  );
  console.log(
    `   Token B: ${displayAmountB.toLocaleString()} ${
      tokenMetadata.tokenBName
    } (raw: ${initialAmountB})\n`
  );
  console.log(`\n🏊 Pool Configuration:`);
  console.log(
    `   Fee Rate: ${poolFeeRatePpm / 10000}% (${poolFeeRatePpm} ppm)`
  );
  console.log(`   Tick Spacing: ${poolTickSpacing}\n`);

  // Run backtest
  const engine = new BacktestEngine({
    poolId: config.poolId,
    token0Name: tokenMetadata.tokenAName,
    token1Name: tokenMetadata.tokenBName,
    startTime: config.startTime,
    endTime: config.endTime,
    stepMs: config.stepMs,
    dataDir: config.dataDir,
    strategyFactory: factory,
    logger: console,
    decimals0: tokenMetadata.tokenADecimals,
    decimals1: tokenMetadata.tokenBDecimals,
    feeRatePpm: poolFeeRatePpm,
    tickSpacing: poolTickSpacing,
    invest0: initialAmountA,
    invest1: initialAmountB,
  });

  await engine.run();

  console.log("\n✅ Backtest completed successfully!");
}

/**
 * Display usage information
 */
function displayUsage(): void {
  console.log(`
Enhanced Backtest Runner

Usage:
  bun run enhanced_backtest_runner.ts [options]

Required Options:
  --poolId <id>           Pool ID to backtest
  --start <date>          Start date (ISO format)
  --end <date>            End date (ISO format)
  --strategy <path>       Path to strategy file

Optional Options:
  --step <ms>             Step interval in milliseconds (default: 1000)
  --dataDir <path>        Data directory path
  --investment <amount>   Initial investment amount (default: 100000)
  --pair <pair>           Trading pair name (default: SUI/USDC)
  --format <format>       Output format: json|table|both|csv (default: csv)
  --output <file>         Output file path
  --enhancedFees          Enable enhanced fee calculation (default: true)
  --detailedReport        Enable detailed reporting (default: true)
  --tokenAName <name>     Token A name (default: from env or "TokenA")
  --tokenADecimals <num>  Token A decimals (default: from env or 9)
  --tokenBName <name>     Token B name (default: from env or "TokenB")
  --tokenBDecimals <num>  Token B decimals (default: from env or 9)
  --feeRatePpm <num>      Pool fee rate in parts per million (default: from env or 1000 = 0.1%)
  --tickSpacing <num>     Pool tick spacing (default: from env or 2)
  `);
}

// Handle help flag
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  displayUsage();
  process.exit(0);
}

// Run main function
if (import.meta.main) {
  main().catch((error) => {
    console.error("❌ Backtest failed:", error.message);
    if (error.stack) {
      console.error(error.stack);
    }
    process.exit(1);
  });
}
