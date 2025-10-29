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
    tokenAName: tokenAName || "TokenA",
    tokenADecimals: tokenADecimals ? parseInt(tokenADecimals) : 9,
    tokenBName: tokenBName || "TokenB",
    tokenBDecimals: tokenBDecimals ? parseInt(tokenBDecimals) : 9,
  };

  process.env.TOKEN_A_NAME = tokenMetadata.tokenAName;
  process.env.TOKEN_A_DECIMALS = tokenMetadata.tokenADecimals.toString();
  process.env.TOKEN_B_NAME = tokenMetadata.tokenBName;
  process.env.TOKEN_B_DECIMALS = tokenMetadata.tokenBDecimals.toString();
  process.env.TRADING_PAIR = config.tradingPair;
  process.env.INITIAL_INVESTMENT = config.initialInvestment.toString();

  console.log(`\n💱 Token Configuration:`);
  console.log(
    `   Token A: ${tokenMetadata.tokenAName} (${tokenMetadata.tokenADecimals} decimals)`
  );
  console.log(
    `   Token B: ${tokenMetadata.tokenBName} (${tokenMetadata.tokenBDecimals} decimals)`
  );
  console.log(`   Quote Currency: ${tokenMetadata.tokenBName}\n`);

  // Run backtest
  const engine = new BacktestEngine({
    poolId: config.poolId,
    startTime: config.startTime,
    endTime: config.endTime,
    stepMs: config.stepMs,
    dataDir: config.dataDir,
    strategyFactory: factory,
    logger: console,
    decimals0: tokenMetadata.tokenADecimals,
    decimals1: tokenMetadata.tokenBDecimals,
    feeRatePpm: 1000,
    tickSpacing: 2,
    invest0: BigInt(0),
    invest1: BigInt(config.initialInvestment),
  });

  const report = await engine.run();

  if (!report) {
    console.error("❌ Backtest failed to generate report");
    process.exit(1);
  }

  console.log("\n✅ Backtest completed successfully!");

  // Enhanced processing if enabled
  if (config.enableEnhancedFees || config.enableDetailedReport) {
    console.log("🔄 Generating enhanced analytics...");

    // Create enhanced components
    const pool = new Pool(0.003, 2); // Will be updated from actual pool data
    // Create a mock position manager with the totals data
    const positionManager = {
      getTotals: () => report.totals,
      getAllPositions: () => [], // Mock empty positions array
      getPositionCount: () => 0,
      getActivePositions: () => [],
    };
    const feeCalculator = new EnhancedFeeCalculator(pool, positionManager);
    const reportGenerator = new ReportGenerator(
      feeCalculator,
      pool,
      positionManager,
      report
    );

    // Generate enhanced report
    const enhancedReport = reportGenerator.generateReport(
      config.startTime,
      config.endTime,
      config.initialInvestment,
      config.tradingPair
    );

    // Output results
    await outputResults(report, enhancedReport, config);
  } else {
    // Standard output
    await outputStandardResults(report, config);
  }
}

/**
 * Output enhanced results in requested format
 */
async function outputResults(
  standardReport: any,
  enhancedReport: any,
  config: EnhancedBacktestConfig
): Promise<void> {
  const reportGenerator = new ReportGenerator(
    null as any,
    null as any,
    null as any,
    standardReport
  );

  // JSON output (only if explicitly requested)
  if (
    !config.streamCsv &&
    (config.outputFormat === "json" || config.outputFormat === "both")
  ) {
    console.log(
      `⚠️  Warning: JSON output can use significant memory for long backtests`
    );
    console.log(`   Consider using --format csv for large datasets`);

    const jsonOutput = {
      standard: standardReport,
      enhanced: enhancedReport,
      finalState: standardReport.finalState || null,
      metadata: {
        generatedAt: new Date().toISOString(),
        version: "1.1.0.73",
        config: {
          poolId: config.poolId,
          tradingPair: config.tradingPair,
          initialInvestment: config.initialInvestment,
          period: {
            start: new Date(config.startTime).toISOString(),
            end: new Date(config.endTime).toISOString(),
            duration: Math.ceil(
              (config.endTime - config.startTime) / (24 * 60 * 60 * 1000)
            ),
          },
        },
      },
    };

    const jsonFile = config.outputFile || `backtest_report_${Date.now()}.json`;
    const jsonReplacer = (key: string, value: any) => {
      if (typeof value === "bigint") {
        return value.toString();
      }
      return value;
    };
    fs.writeFileSync(jsonFile, JSON.stringify(jsonOutput, jsonReplacer, 2));
    console.log(`📄 JSON report saved to: ${jsonFile}`);
  }

  // CSV output (memory-efficient, already streamed during backtest)
  if (config.streamCsv || config.outputFormat === "csv") {
    console.log(`✅ CSV reports were streamed during backtest execution`);
    console.log(`   Check ./snapshots/ directory for vault and position CSVs`);
  }

  // Table output
  if (config.outputFormat === "table" || config.outputFormat === "both") {
    const tableOutput = reportGenerator.formatReportAsTable(enhancedReport);

    console.log("\n" + tableOutput);

    if (config.outputFile) {
      const tableFile = config.outputFile.replace(".json", ".txt");
      fs.writeFileSync(tableFile, tableOutput);
      console.log(`📋 Table report saved to: ${tableFile}`);
    }
  }

  // Performance summary
  console.log("\n📊 PERFORMANCE SUMMARY");
  console.log("═".repeat(50));
  console.log(
    `💰 Net Profit: $${enhancedReport.performance.netProfit.toLocaleString()}`
  );
  console.log(
    `📈 Return: ${enhancedReport.performance.returnPercentage.toFixed(2)}%`
  );
  console.log(`🎯 APR: ${enhancedReport.performance.netAPR.toFixed(2)}%`);
  console.log(
    `💎 Total Fees: $${(
      Number(enhancedReport.enhancedFees.totalFeesEarned) / 1e6
    ).toLocaleString()}`
  );
  console.log(
    `⚡ Fee Accuracy: ${(enhancedReport.enhancedFees.feeAccuracy * 100).toFixed(
      2
    )}%`
  );
  console.log(
    `✅ Validation Score: ${(enhancedReport.validationScore * 100).toFixed(2)}%`
  );
  console.log(
    `⏱️  Time in Range: ${enhancedReport.performance.timeInRangePercentage.toFixed(
      2
    )}%`
  );
  console.log(
    `🔄 Total Positions: ${enhancedReport.performance.totalPositions}`
  );

  // Final state summary
  if (standardReport.finalState) {
    console.log("\n📍 FINAL STATE");
    console.log("═".repeat(50));
    console.log(
      `💱 Current Price: ${standardReport.finalState.currentPrice.toFixed(8)}`
    );
    console.log(`📊 Current Tick: ${standardReport.finalState.currentTick}`);
    console.log(`💧 Pool Liquidity: ${standardReport.finalState.liquidity}`);
    console.log(
      `📦 Open Positions: ${standardReport.finalState.openPositions.length}`
    );

    if (standardReport.finalState.openPositions.length > 0) {
      console.log("\n📋 OPEN POSITIONS:");
      for (let i = 0; i < standardReport.finalState.openPositions.length; i++) {
        const pos = standardReport.finalState.openPositions[i];
        console.log(
          `\n  Position ${i + 1} ${pos.isActive ? "🟢 ACTIVE" : "⚪ INACTIVE"}:`
        );
        console.log(
          `    Price Range: [${pos.priceLower.toFixed(
            8
          )}, ${pos.priceUpper.toFixed(8)}]`
        );
        console.log(`    Mid Price: ${pos.midPrice.toFixed(8)}`);
        console.log(`    Width: ${pos.widthPercent.toFixed(4)}%`);
        console.log(
          `    Distance: ${pos.distanceFromCurrentPercent.toFixed(4)}%`
        );
        console.log(`    Liquidity: ${pos.liquidity}`);
        console.log(`    Balances: ${pos.amountA} A / ${pos.amountB} B`);
      }
    }
  }
}

/**
 * Output standard results
 */
async function outputStandardResults(
  report: any,
  config: EnhancedBacktestConfig
): Promise<void> {
  const jsonOutput = {
    ...report,
    metadata: {
      generatedAt: new Date().toISOString(),
      config: {
        poolId: config.poolId,
        initialInvestment: config.initialInvestment,
      },
    },
  };

  if (config.outputFile) {
    fs.writeFileSync(config.outputFile, JSON.stringify(jsonOutput, null, 2));
    console.log(`📄 Report saved to: ${config.outputFile}`);
  } else {
    console.log("\n📊 BACKTEST RESULTS");
    console.log(JSON.stringify(jsonOutput, null, 2));
  }
}

/**
 * Display usage information
 */
function displayUsage(): void {
  console.log(`
🚀 Enhanced Backtest Runner

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
  --format <format>       Output format: json|table|both (default: both)
  --output <file>         Output file path
  --enhancedFees          Enable enhanced fee calculation (default: true)
  --detailedReport        Enable detailed reporting (default: true)

Examples:
  # Basic backtest with enhanced features
  bun run enhanced_backtest_runner.ts \\
    --poolId 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 \\
    --start "2025-08-20T00:00:00Z" \\
    --end "2025-08-30T00:00:00Z" \\
    --strategy ./src/strategies/three_band_rebalancer_backtest.ts \\
    --investment 100000 \\
    --format both

  # Generate table report only
  bun run enhanced_backtest_runner.ts \\
    --poolId 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 \\
    --start "2025-08-20T00:00:00Z" \\
    --end "2025-08-30T00:00:00Z" \\
    --strategy ./src/strategies/three_band_rebalancer_backtest.ts \\
    --format table \\
    --output backtest_report.txt
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
