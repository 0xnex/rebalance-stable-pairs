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
    // Use cumulative metrics if available (for positions that have been rebalanced)
    // Otherwise use current iteration metrics
    const hasCumulativeData = pos.cumulativeOpenTime > 0 && pos.cumulativeOpenTime !== pos.openTime;
    const effectiveOpenTime = hasCumulativeData ? pos.cumulativeOpenTime : pos.openTime || ts;
    const effectiveInitialAmount0 = hasCumulativeData ? pos.cumulativeInitialAmount0 : pos.initialAmount0;
    const effectiveInitialAmount1 = hasCumulativeData ? pos.cumulativeInitialAmount1 : pos.initialAmount1;
    const effectiveInRangeTimeMs = hasCumulativeData 
      ? pos.cumulativeTotalInRangeTimeMs + pos.totalInRangeTimeMs 
      : pos.totalInRangeTimeMs;
    
    // Calculate initial value in token1 using effective amounts
    const initialValue = convertToToken1(effectiveInitialAmount0, currentPrice) + effectiveInitialAmount1;

    // Calculate position value (amount + fees)
    // Use finalAmount for closed positions, current amount for open positions
    const currentAmount0 = pos.isClosed ? pos.finalAmount0 : pos.amount0;
    const currentAmount1 = pos.isClosed ? pos.finalAmount1 : pos.amount1;
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
    // For rebalanced positions, the capital is recycled through close/reopen cycles.
    // The meaningful PnL is: fees earned - costs incurred
    // (The position value doesn't reflect the true performance since funds are continuously moved to/from wallet)
    let pnl: bigint;
    if (hasCumulativeData) {
      // For rebalanced positions: PnL = total fees - slippage - swap costs
      pnl = totalFeeEarned - slippageCost - swapCost;
    } else {
      // For non-rebalanced positions: PnL = current value - initial value
      pnl = positionValue - initialValue;
    }
    
    const roiPercent = initialValue > 0n 
      ? Number((pnl * 10000n) / initialValue) / 100 
      : 0;

    // Calculate duration using effective open time
    const openTime = effectiveOpenTime;
    const closeTime = pos.isClosed ? (pos.closeTime || ts) : ts;
    const durationMs = closeTime - openTime;
    const durationDays = durationMs / (1000 * 60 * 60 * 24);
    const durationYears = durationDays / 365;

    // Calculate APR and APY
    let apr = 0;
    let apy = 0;
    if (durationYears > 0 && initialValue > 0n) {
      // APR: simple annualization
      apr = roiPercent / durationYears;
      
      // APY: compound annualization
      const dailyReturn = roiPercent / 100 / durationDays;
      if (dailyReturn > -1 && durationDays > 0) {
        apy = (Math.pow(1 + dailyReturn, 365) - 1) * 100;
      }
    }

    // Calculate in-range time and percentage using effective in-range time
    const inRangeTimeMs = effectiveInRangeTimeMs || 0;
    const inRangePercent = durationMs > 0 ? (inRangeTimeMs / durationMs) * 100 : 0;

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
      apr,
      apy,
      openTime,
      closeTime,
      durationMs,
      durationDays,
      inRangeTimeMs,
      inRangePercent,
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
    "apr",
    "apy",
    "open_time",
    "close_time",
    "duration_ms",
    "duration_days",
    "in_range_time_ms",
    "in_range_percent",
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
    numberToString(p.apr, 4),
    numberToString(p.apy, 4),
    p.openTime.toString(),
    p.closeTime.toString(),
    p.durationMs.toString(),
    numberToString(p.durationDays, 4),
    p.inRangeTimeMs.toString(),
    numberToString(p.inRangePercent, 2),
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

