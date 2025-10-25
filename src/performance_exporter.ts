import { writeFile, mkdir, appendFile } from "node:fs/promises";
import { join } from "node:path";
import type { FundPerformance, PositionPerformance, IPool, IPositionManager } from "./types";

// ============================================================================
// Performance Calculation Functions
// ============================================================================

/**
 * Get current pool price (token1 per token0)
 */
function getCurrentPrice(pool: IPool): number {
  return (pool as any).price();
}

/**
 * Convert amount0 to token1 terms using current price
 */
function convertToToken1(amount0: bigint, price: number): bigint {
  if (!isFinite(price) || price <= 0) {
    return 0n;
  }
  const amount0Num = Number(amount0);
  const valueInToken1 = amount0Num * price;
  if (!isFinite(valueInToken1)) {
    return 0n;
  }
  return BigInt(Math.floor(valueInToken1));
}

/**
 * Calculate fund-level performance metrics
 */
export function calculateFundPerformance(
  pool: IPool,
  manager: IPositionManager,
  initialAmount0: bigint,
  initialAmount1: bigint,
  timestamp?: number
): FundPerformance {
  const ts = timestamp ?? Date.now();
  const currentPrice = getCurrentPrice(pool);

  // Get current wallet balance
  const balance0 = manager.getBalance0();
  const balance1 = manager.getBalance1();

  // Calculate initial value in token1
  const initialValue = convertToToken1(initialAmount0, currentPrice) + initialAmount1;

  // Calculate total position value
  const positions = manager.getPositions();
  let totalPositionValue = 0n;
  let totalFeeEarned = 0n;
  let totalSlippageCost = 0n;
  let totalSwapCost = 0n;

  for (const pos of positions) {
    const posValue = convertToToken1(pos.amount0, currentPrice) + pos.amount1;
    const feeValue = convertToToken1(pos.fee0, currentPrice) + pos.fee1;
    const slippageCost = convertToToken1(pos.slip0, currentPrice) + pos.slip1;
    const swapCost = convertToToken1(pos.cost0, currentPrice) + pos.cost1;

    totalPositionValue += posValue + feeValue;
    totalFeeEarned += convertToToken1(pos.accumulatedFee0, currentPrice) + pos.accumulatedFee1;
    totalSlippageCost += slippageCost;
    totalSwapCost += swapCost;
  }

  // Calculate total value (balance + positions)
  const balanceValue = convertToToken1(balance0, currentPrice) + balance1;
  const totalValue = balanceValue + totalPositionValue;

  // Calculate PnL and ROI
  const pnl = totalValue - initialValue;
  const roiPercent = initialValue > 0n 
    ? Number((pnl * 10000n) / initialValue) / 100 
    : 0;

  return {
    timestamp: ts,
    initialAmount0,
    initialAmount1,
    initialValue,
    currentBalance0: balance0,
    currentBalance1: balance1,
    totalPositionValue,
    totalFeeEarned,
    totalValue,
    pnl,
    roiPercent,
    totalSlippageCost,
    totalSwapCost,
    currentPrice,
  };
}

/**
 * Calculate position-level performance metrics
 */
export function calculatePositionsPerformance(
  pool: IPool,
  manager: IPositionManager,
  timestamp?: number
): PositionPerformance[] {
  const ts = timestamp ?? Date.now();
  const currentPrice = getCurrentPrice(pool);
  const currentTick = (pool as any).tick;

  return manager.getPositions().map((pos) => {
    // Calculate initial value in token1
    const initialValue = convertToToken1(pos.initialAmount0, currentPrice) + pos.initialAmount1;

    // Calculate position value (amount + fees)
    const currentAmount0 = pos.amount0;
    const currentAmount1 = pos.amount1;
    const positionValue = 
      convertToToken1(currentAmount0, currentPrice) + 
      currentAmount1 + 
      convertToToken1(pos.fee0, currentPrice) + 
      pos.fee1;

    // Calculate total fee earned
    const totalFeeEarned = convertToToken1(pos.accumulatedFee0, currentPrice) + pos.accumulatedFee1;

    // Calculate costs
    const slippageCost = convertToToken1(pos.slip0, currentPrice) + pos.slip1;
    const swapCost = convertToToken1(pos.cost0, currentPrice) + pos.cost1;

    // Calculate PnL and ROI
    const pnl = positionValue - initialValue;
    const roiPercent = initialValue > 0n 
      ? Number((pnl * 10000n) / initialValue) / 100 
      : 0;

    return {
      timestamp: ts,
      positionId: pos.id,
      lowerTick: pos.lower,
      upperTick: pos.upper,
      status: pos.isClosed ? 'closed' : 'active',
      isInRange: pos.isInRange(currentTick),
      liquidity: pos.L,
      initialAmount0: pos.initialAmount0,
      initialAmount1: pos.initialAmount1,
      initialValue,
      currentAmount0,
      currentAmount1,
      positionValue,
      fee0: pos.fee0,
      fee1: pos.fee1,
      totalFeeEarned,
      pnl,
      roiPercent,
      slippage0: pos.slip0,
      slippage1: pos.slip1,
      slippageCost,
      swapCost0: pos.cost0,
      swapCost1: pos.cost1,
      swapCost,
      currentPrice,
    };
  });
}

// ============================================================================
// CSV Export Functions
// ============================================================================

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
 * Exports fund performance data to CSV (appends to existing file)
 */
export async function exportFundPerformanceToCSV(
  performance: FundPerformance,
  outputPath: string,
  append: boolean = false
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

  // Ensure directory exists
  const dir = outputPath.substring(0, outputPath.lastIndexOf("/"));
  if (dir) {
    await mkdir(dir, { recursive: true });
  }

  let csv: string;
  if (append) {
    // Only append the data row
    csv = row.join(",") + "\n";
    await appendFile(outputPath, csv, "utf-8");
  } else {
    // Write headers + first row
    csv = [headers.join(","), row.join(",")].join("\n") + "\n";
    await writeFile(outputPath, csv, "utf-8");
  }

  return outputPath;
}

/**
 * Exports position performance data to CSV (appends to existing file)
 */
export async function exportPositionPerformanceToCSV(
  performances: PositionPerformance[],
  outputPath: string,
  append: boolean = false
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

  // Ensure directory exists
  const dir = outputPath.substring(0, outputPath.lastIndexOf("/"));
  if (dir) {
    await mkdir(dir, { recursive: true });
  }

  if (append) {
    // Only append data rows
    const csv = rows.map((r) => r.join(",")).join("\n") + "\n";
    await appendFile(outputPath, csv, "utf-8");
  } else {
    // Write headers + data rows
    const csv = [headers.join(","), ...rows.map((r) => r.join(","))].join("\n") + "\n";
    await writeFile(outputPath, csv, "utf-8");
  }

  return outputPath;
}

/**
 * Exports both fund and position performance data to CSV files
 */
export async function exportPerformanceToCSV(
  fundPerformance: FundPerformance,
  positionPerformances: PositionPerformance[],
  outputDir: string,
  append: boolean = false
): Promise<{ fundCsvPath: string; positionsCsvPath: string }> {
  const timestamp = fundPerformance.timestamp;
  const fundCsvPath = join(outputDir, `fund_performance.csv`);
  const positionsCsvPath = join(outputDir, `position_performance.csv`);

  await Promise.all([
    exportFundPerformanceToCSV(fundPerformance, fundCsvPath, append),
    exportPositionPerformanceToCSV(positionPerformances, positionsCsvPath, append),
  ]);

  return { fundCsvPath, positionsCsvPath };
}

