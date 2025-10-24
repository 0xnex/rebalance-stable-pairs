import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { FundPerformance, PositionPerformance } from "./types";

/**
 * Converts a BigInt value to a string for CSV export
 */
function bigintToString(value: bigint): string {
  return value.toString();
}

/**
 * Converts a number to a string with fixed decimal places
 */
function numberToString(value: number, decimals: number = 6): string {
  return value.toFixed(decimals);
}

/**
 * Exports fund performance data to CSV
 */
export async function exportFundPerformanceToCSV(
  performance: FundPerformance,
  outputPath: string
): Promise<string> {
  const headers = [
    "timestamp",
    "initial_amount0",
    "initial_amount1",
    "initial_value",
    "current_balance0",
    "current_balance1",
    "total_position_value",
    "total_fee_earned",
    "total_value",
    "pnl",
    "roi_percent",
    "total_slippage_cost",
    "total_swap_cost",
    "current_price",
  ];

  const row = [
    performance.timestamp.toString(),
    bigintToString(performance.initialAmount0),
    bigintToString(performance.initialAmount1),
    bigintToString(performance.initialValue),
    bigintToString(performance.currentBalance0),
    bigintToString(performance.currentBalance1),
    bigintToString(performance.totalPositionValue),
    bigintToString(performance.totalFeeEarned),
    bigintToString(performance.totalValue),
    bigintToString(performance.pnl),
    numberToString(performance.roiPercent, 4),
    bigintToString(performance.totalSlippageCost),
    bigintToString(performance.totalSwapCost),
    numberToString(performance.currentPrice, 10),
  ];

  const csv = [headers.join(","), row.join(",")].join("\n");

  // Ensure directory exists
  const dir = outputPath.substring(0, outputPath.lastIndexOf("/"));
  if (dir) {
    await mkdir(dir, { recursive: true });
  }

  await writeFile(outputPath, csv, "utf-8");
  return outputPath;
}

/**
 * Exports position performance data to CSV
 */
export async function exportPositionPerformanceToCSV(
  performances: PositionPerformance[],
  outputPath: string
): Promise<string> {
  const headers = [
    "timestamp",
    "position_id",
    "lower_tick",
    "upper_tick",
    "status",
    "is_in_range",
    "liquidity",
    "initial_amount0",
    "initial_amount1",
    "initial_value",
    "current_amount0",
    "current_amount1",
    "position_value",
    "fee0",
    "fee1",
    "total_fee_earned",
    "pnl",
    "roi_percent",
    "slippage0",
    "slippage1",
    "slippage_cost",
    "swap_cost0",
    "swap_cost1",
    "swap_cost",
    "current_price",
  ];

  const rows = performances.map((p) => [
    p.timestamp.toString(),
    p.positionId,
    p.lowerTick.toString(),
    p.upperTick.toString(),
    p.status,
    p.isInRange.toString(),
    bigintToString(p.liquidity),
    bigintToString(p.initialAmount0),
    bigintToString(p.initialAmount1),
    bigintToString(p.initialValue),
    bigintToString(p.currentAmount0),
    bigintToString(p.currentAmount1),
    bigintToString(p.positionValue),
    bigintToString(p.fee0),
    bigintToString(p.fee1),
    bigintToString(p.totalFeeEarned),
    bigintToString(p.pnl),
    numberToString(p.roiPercent, 4),
    bigintToString(p.slippage0),
    bigintToString(p.slippage1),
    bigintToString(p.slippageCost),
    bigintToString(p.swapCost0),
    bigintToString(p.swapCost1),
    bigintToString(p.swapCost),
    numberToString(p.currentPrice, 10),
  ]);

  const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");

  // Ensure directory exists
  const dir = outputPath.substring(0, outputPath.lastIndexOf("/"));
  if (dir) {
    await mkdir(dir, { recursive: true });
  }

  await writeFile(outputPath, csv, "utf-8");
  return outputPath;
}

/**
 * Exports both fund and position performance data to CSV files
 */
export async function exportPerformanceToCSV(
  fundPerformance: FundPerformance,
  positionPerformances: PositionPerformance[],
  outputDir: string
): Promise<{ fundCsvPath: string; positionsCsvPath: string }> {
  const timestamp = fundPerformance.timestamp;
  const fundCsvPath = join(outputDir, `fund_performance_${timestamp}.csv`);
  const positionsCsvPath = join(
    outputDir,
    `position_performance_${timestamp}.csv`
  );

  await Promise.all([
    exportFundPerformanceToCSV(fundPerformance, fundCsvPath),
    exportPositionPerformanceToCSV(positionPerformances, positionsCsvPath),
  ]);

  return { fundCsvPath, positionsCsvPath };
}

