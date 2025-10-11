#!/usr/bin/env bun
/**
 * Enhanced Backtest Runner với improved fee calculation và detailed reporting
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
    outputFormat: 'json' | 'table' | 'both';
    outputFile?: string;
    enableEnhancedFees: boolean;
    enableDetailedReport: boolean;
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
            detailedReport
        },
    } = parseArgs({
        options: {
            poolId: { type: "string" },
            start: { type: "string" },
            end: { type: "string" },
            step: { type: "string" },
            dataDir: { type: "string" },
            strategy: { type: "string" },
            investment: { type: "string" },
            pair: { type: "string" },
            format: { type: "string" },
            output: { type: "string" },
            enhancedFees: { type: "boolean" },
            detailedReport: { type: "boolean" }
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
        dataDir: dataDir ? path.resolve(process.cwd(), dataDir) : path.resolve(__dirname, "../mmt_txs", poolId),
        strategyPath: path.isAbsolute(strategyPath) ? strategyPath : path.join(process.cwd(), strategyPath),
        initialInvestment: investment ? parseFloat(investment) : 100000,
        tradingPair: pair || 'SUI/USDC',
        outputFormat: (format as 'json' | 'table' | 'both') || 'both',
        outputFile: output,
        enableEnhancedFees: enhancedFees !== false,
        enableDetailedReport: detailedReport !== false
    };

    console.log(`🚀 Starting Enhanced Backtest...`);
    console.log(`📊 Pool: ${config.poolId}`);
    console.log(`📅 Period: ${new Date(startTime).toISOString()} → ${new Date(endTime).toISOString()}`);
    console.log(`💰 Initial Investment: $${config.initialInvestment.toLocaleString()}`);
    console.log(`⚡ Enhanced Fees: ${config.enableEnhancedFees ? 'Enabled' : 'Disabled'}`);
    console.log(`📋 Detailed Report: ${config.enableDetailedReport ? 'Enabled' : 'Disabled'}`);

    // Load strategy
    const modUrl = pathToFileURL(config.strategyPath).href;
    const mod: StrategyModule = await import(modUrl);
    const factory = mod.strategyFactory ?? mod.default;
    if (typeof factory !== "function") {
        throw new Error(
            `Strategy module must export a default function or strategyFactory(pool) => strategy`
        );
    }

    // Run backtest
    const engine = new BacktestEngine({
        poolId: config.poolId,
        startTime: config.startTime,
        endTime: config.endTime,
        stepMs: config.stepMs,
        dataDir: config.dataDir,
        strategyFactory: factory,
        logger: console,
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
            getActivePositions: () => []
        };
        const feeCalculator = new EnhancedFeeCalculator(pool, positionManager);
        const reportGenerator = new ReportGenerator(feeCalculator, pool, positionManager, report);

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
    const reportGenerator = new ReportGenerator(null as any, null as any, null as any, standardReport);

    // JSON output
    if (config.outputFormat === 'json' || config.outputFormat === 'both') {
        const jsonOutput = {
            standard: standardReport,
            enhanced: enhancedReport,
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
                        duration: Math.ceil((config.endTime - config.startTime) / (24 * 60 * 60 * 1000))
                    }
                }
            }
        };

        const jsonFile = config.outputFile || `backtest_report_${Date.now()}.json`;
        // Custom replacer to handle BigInt
        const jsonReplacer = (key: string, value: any) => {
            if (typeof value === 'bigint') {
                return value.toString();
            }
            return value;
        };
        fs.writeFileSync(jsonFile, JSON.stringify(jsonOutput, jsonReplacer, 2));
        console.log(`📄 JSON report saved to: ${jsonFile}`);
    }

    // Table output
    if (config.outputFormat === 'table' || config.outputFormat === 'both') {
        const tableOutput = reportGenerator.formatReportAsTable(enhancedReport);

        console.log("\n" + tableOutput);

        if (config.outputFile) {
            const tableFile = config.outputFile.replace('.json', '.txt');
            fs.writeFileSync(tableFile, tableOutput);
            console.log(`📋 Table report saved to: ${tableFile}`);
        }
    }

    // Performance summary
    console.log("\n📊 PERFORMANCE SUMMARY");
    console.log("═".repeat(50));
    console.log(`💰 Net Profit: $${enhancedReport.performance.netProfit.toLocaleString()}`);
    console.log(`📈 Return: ${enhancedReport.performance.returnPercentage.toFixed(2)}%`);
    console.log(`🎯 APR: ${enhancedReport.performance.netAPR.toFixed(2)}%`);
    console.log(`💎 Total Fees: $${(Number(enhancedReport.enhancedFees.totalFeesEarned) / 1e6).toLocaleString()}`);
    console.log(`⚡ Fee Accuracy: ${(enhancedReport.enhancedFees.feeAccuracy * 100).toFixed(2)}%`);
    console.log(`✅ Validation Score: ${(enhancedReport.validationScore * 100).toFixed(2)}%`);
    console.log(`⏱️  Time in Range: ${enhancedReport.performance.timeInRangePercentage.toFixed(2)}%`);
    console.log(`🔄 Total Positions: ${enhancedReport.performance.totalPositions}`);
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
                initialInvestment: config.initialInvestment
            }
        }
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
if (process.argv.includes('--help') || process.argv.includes('-h')) {
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
