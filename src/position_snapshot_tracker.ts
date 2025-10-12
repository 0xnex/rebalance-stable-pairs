/**
 * Position Snapshot Tracker
 * Tracks detailed information for each position during backtest with 1-minute intervals
 *
 * PRICING CONVENTION:
 * - All values are quoted in Token B (Token1), the quote currency
 * - Token A (Token0) = base token
 * - Token B (Token1) = quote token (e.g., USDC, USDT)
 * - Variables named "*USD" actually mean "*Quote" (in TokenB terms)
 */

import * as fs from "fs";
import * as path from "path";
import {
  VirtualPositionManager,
  type VirtualPosition,
} from "./virtual_position_mgr";
import { Pool } from "./pool";

export interface PositionSnapshot {
  positionId: string;
  timestamp: number;
  timestampISO: string;
  tickRange: {
    tickLower: number;
    tickUpper: number;
    tickWidth: number;
  };
  liquidity: {
    amount: string;
    isActive: boolean;
    inRange: boolean;
    utilization: number;
  };
  tokens: {
    amount0: string;
    amount1: string;
    value0USD: number;
    value1USD: number;
    totalValueUSD: number;
    priceA: number;
    priceB: number;
  };
  fees: {
    collected0: string;
    collected1: string;
    owed0: string;
    owed1: string;
    feeGrowthInside0LastX64: string;
    feeGrowthInside1LastX64: string;
    accruedFees0: string;
    accruedFees1: string;
    totalFeesUSD: number;
    feeYieldAPR: number;
    feeYieldDaily: number;
  };
  performance: {
    unrealizedPnL: number;
    unrealizedPnLPct: number;
    realizedPnL: number;
    feeYield: number;
    totalReturn: number;
    totalReturnPct: number;
    timeInRange: number;
    timeOutOfRange: number;
    timeInRangePct: number;
    roi: number;
    sharpeRatio: number;
  };
  priceInfo: {
    currentPrice: number;
    lowerPrice: number;
    upperPrice: number;
    pricePosition: "below" | "in_range" | "above";
    distanceFromRange: number;
    priceRatio: number;
    volatility: number;
  };
  utilization: {
    liquidityUtilization: number;
    capitalEfficiency: number;
    impermanentLoss: number;
    impermanentLossPct: number;
    holdingValue: number;
    currentValue: number;
  };
  swapAnalysis?: {
    optimalSwaps: SwapPlan[];
    totalSwapValue: number;
    swapEfficiency: number;
    avoidedRoundTrips: boolean;
  };
}

export interface SwapPlan {
  fromToken: string;
  toToken: string;
  swapValueUSD: number;
  swapAmountFrom: number;
  swapAmountTo: number;
  reason: string;
  routingType: "optimal" | "direct" | "multi-hop";
  efficiency: number;
}

export interface PositionSummarySnapshot {
  timestamp: number;
  timestampISO: string;
  totalPositions: number;
  activePositions: number;
  inRangePositions: number;
  outOfRangePositions: number;
  totalLiquidity: string;
  totalValueUSD: number;
  totalFeesUSD: number;
  averageTickWidth: number;
  positionDistribution: {
    below: number;
    inRange: number;
    above: number;
  };
  performanceMetrics: {
    avgUnrealizedPnL: number;
    avgUnrealizedPnLPct: number;
    avgRealizedPnL: number;
    avgFeeYield: number;
    avgFeeYieldAPR: number;
    avgTimeInRange: number;
    avgTimeInRangePct: number;
    totalImpermanentLoss: number;
    totalImpermanentLossPct: number;
    avgROI: number;
    avgSharpeRatio: number;
    totalReturn: number;
    totalReturnPct: number;
  };
  riskMetrics: {
    portfolioVolatility: number;
    maxDrawdown: number;
    valueAtRisk: number;
    expectedShortfall: number;
  };
  optimizationAnalysis: {
    totalSwapOpportunities: number;
    totalSwapValue: number;
    avgSwapEfficiency: number;
    roundTripsAvoided: number;
  };
}

export class PositionSnapshotTracker {
  private positionSnapshots: Map<string, PositionSnapshot[]> = new Map();
  private summarySnapshots: PositionSummarySnapshot[] = [];
  private lastSnapshotTime: number = 0;
  private readonly snapshotInterval: number = 60 * 1000; // 1 minute
  private readonly outputDir: string;
  private positionStartTimes: Map<string, number> = new Map();
  private positionInRangeTimes: Map<string, number> = new Map();

  constructor(
    private readonly positionManager: VirtualPositionManager,
    private readonly pool: Pool,
    outputDir: string = "./snapshots"
  ) {
    this.outputDir = outputDir;
    this.ensureOutputDir();
  }

  /**
   * Ensure output directory exists
   */
  private ensureOutputDir(): void {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Initialize tracking
   */
  public initialize(startTime: number): void {
    this.lastSnapshotTime = startTime;
    this.captureSnapshot(startTime, true);
  }

  /**
   * Update snapshot if enough time has passed
   */
  public update(currentTime: number): void {
    if (currentTime - this.lastSnapshotTime >= this.snapshotInterval) {
      this.captureSnapshot(currentTime);
      this.lastSnapshotTime = currentTime;
    }
  }

  /**
   * Capture snapshot at current time
   */
  private captureSnapshot(timestamp: number, isInitial: boolean = false): void {
    const positions = this.getAllPositions();
    const positionSnapshots: PositionSnapshot[] = [];

    // Capture individual position snapshots
    for (const position of positions) {
      const snapshot = this.createPositionSnapshot(position, timestamp);
      positionSnapshots.push(snapshot);

      // Store in position history
      const positionId = snapshot.positionId;
      if (!this.positionSnapshots.has(positionId)) {
        this.positionSnapshots.set(positionId, []);
        this.positionStartTimes.set(positionId, timestamp);
        this.positionInRangeTimes.set(positionId, 0);
      }
      this.positionSnapshots.get(positionId)!.push(snapshot);

      // Update time tracking
      this.updateTimeTracking(positionId, snapshot, timestamp);
    }

    // Create summary snapshot
    const summarySnapshot = this.createSummarySnapshot(
      positionSnapshots,
      timestamp
    );
    this.summarySnapshots.push(summarySnapshot);

    // Log snapshot if initial or every 10 minutes
    if (isInitial || this.summarySnapshots.length % 10 === 0) {
      console.log(
        `📊 Position Snapshot [${summarySnapshot.timestampISO}]: ${
          summarySnapshot.totalPositions
        } positions, ${
          summarySnapshot.inRangePositions
        } in-range, Value=$${summarySnapshot.totalValueUSD.toFixed(2)}`
      );
    }
  }

  /**
   * Create snapshot for a position with enhanced metrics
   */
  private createPositionSnapshot(
    position: VirtualPosition,
    timestamp: number
  ): PositionSnapshot {
    const currentTick = (this.pool as any).tickCurrent || 0;
    const inRange =
      currentTick >= position.tickLower && currentTick < position.tickUpper;
    const priceA = this.calculateTokenPrice("A");
    const priceB = this.calculateTokenPrice("B");
    const value0USD = this.calculateTokenValue(position.tokensOwed0, "A");
    const value1USD = this.calculateTokenValue(position.tokensOwed1, "B");
    const totalValueUSD = value0USD + value1USD;
    const timeInRange = this.getTimeInRange(position, timestamp);
    const timeOutOfRange = this.getTimeOutOfRange(position, timestamp);
    const totalTime = timeInRange + timeOutOfRange;
    const unrealizedPnL = this.calculateUnrealizedPnL(position);
    const realizedPnL = this.calculateRealizedPnL(position);
    const impermanentLoss = this.calculateImpermanentLoss(position);
    const holdingValue = this.calculateHoldingValue(position);

    return {
      positionId: this.generatePositionId(position),
      timestamp,
      timestampISO: new Date(timestamp).toISOString(),
      tickRange: {
        tickLower: position.tickLower,
        tickUpper: position.tickUpper,
        tickWidth: position.tickUpper - position.tickLower,
      },
      liquidity: {
        amount: position.liquidity.toString(),
        isActive: position.liquidity > 0n,
        inRange,
        utilization: this.calculateLiquidityUtilization(position),
      },
      tokens: {
        amount0: position.tokensOwed0.toString(),
        amount1: position.tokensOwed1.toString(),
        value0USD,
        value1USD,
        totalValueUSD,
        priceA,
        priceB,
      },
      fees: {
        collected0: position.tokensOwed0.toString(),
        collected1: position.tokensOwed1.toString(),
        owed0: position.tokensOwed0.toString(),
        owed1: position.tokensOwed1.toString(),
        feeGrowthInside0LastX64: position.feeGrowthInside0LastX64.toString(),
        feeGrowthInside1LastX64: position.feeGrowthInside1LastX64.toString(),
        accruedFees0: this.calculateAccruedFees(position, 0).toString(),
        accruedFees1: this.calculateAccruedFees(position, 1).toString(),
        totalFeesUSD: this.calculateTotalFeesUSD(position),
        feeYieldAPR: this.calculateFeeYieldAPR(position),
        feeYieldDaily: this.calculateFeeYieldDaily(position),
      },
      performance: {
        unrealizedPnL,
        unrealizedPnLPct:
          totalValueUSD > 0 ? (unrealizedPnL / totalValueUSD) * 100 : 0,
        realizedPnL,
        feeYield: this.calculateFeeYield(position),
        totalReturn: unrealizedPnL + realizedPnL,
        totalReturnPct:
          totalValueUSD > 0
            ? ((unrealizedPnL + realizedPnL) / totalValueUSD) * 100
            : 0,
        timeInRange,
        timeOutOfRange,
        timeInRangePct: totalTime > 0 ? (timeInRange / totalTime) * 100 : 0,
        roi: this.calculateROI(position),
        sharpeRatio: this.calculateSharpeRatio(position),
      },
      priceInfo: {
        currentPrice: this.getCurrentPrice(),
        lowerPrice: this.tickToPrice(position.tickLower),
        upperPrice: this.tickToPrice(position.tickUpper),
        pricePosition: this.getPricePosition(position),
        distanceFromRange: this.getDistanceFromRange(position),
        priceRatio: priceB > 0 ? priceA / priceB : 0,
        volatility: this.calculateVolatility(position),
      },
      utilization: {
        liquidityUtilization: this.calculateLiquidityUtilization(position),
        capitalEfficiency: this.calculateCapitalEfficiency(position),
        impermanentLoss,
        impermanentLossPct:
          holdingValue > 0 ? (impermanentLoss / holdingValue) * 100 : 0,
        holdingValue,
        currentValue: totalValueUSD,
      },
      swapAnalysis: this.analyzeSwapOpportunities(position),
    };
  }

  /**
   * Create enhanced summary snapshot with comprehensive metrics
   */
  private createSummarySnapshot(
    positionSnapshots: PositionSnapshot[],
    timestamp: number
  ): PositionSummarySnapshot {
    const totalPositions = positionSnapshots.length;
    const activePositions = positionSnapshots.filter(
      (p) => p.liquidity.isActive
    ).length;
    const inRangePositions = positionSnapshots.filter(
      (p) => p.liquidity.inRange
    ).length;
    const outOfRangePositions = totalPositions - inRangePositions;

    const belowRange = positionSnapshots.filter(
      (p) => p.priceInfo.pricePosition === "below"
    ).length;
    const aboveRange = positionSnapshots.filter(
      (p) => p.priceInfo.pricePosition === "above"
    ).length;

    // Calculate aggregated metrics
    const totalValueUSD = positionSnapshots.reduce(
      (sum, p) => sum + p.tokens.totalValueUSD,
      0
    );
    const totalFeesUSD = positionSnapshots.reduce(
      (sum, p) => sum + p.fees.totalFeesUSD,
      0
    );
    const totalUnrealizedPnL = positionSnapshots.reduce(
      (sum, p) => sum + p.performance.unrealizedPnL,
      0
    );
    const totalRealizedPnL = positionSnapshots.reduce(
      (sum, p) => sum + p.performance.realizedPnL,
      0
    );
    const totalReturn = totalUnrealizedPnL + totalRealizedPnL;
    const totalImpermanentLoss = positionSnapshots.reduce(
      (sum, p) => sum + p.utilization.impermanentLoss,
      0
    );
    const totalHoldingValue = positionSnapshots.reduce(
      (sum, p) => sum + p.utilization.holdingValue,
      0
    );

    // Calculate portfolio volatility
    const portfolioVolatility =
      this.calculatePortfolioVolatility(positionSnapshots);
    const maxDrawdown = this.calculateMaxDrawdown();
    const valueAtRisk = this.calculateValueAtRisk(positionSnapshots);
    const expectedShortfall =
      this.calculateExpectedShortfall(positionSnapshots);

    // Swap analysis aggregation
    const swapAnalyses = positionSnapshots
      .filter((p) => p.swapAnalysis)
      .map((p) => p.swapAnalysis!);
    const totalSwapOpportunities = swapAnalyses.length;
    const totalSwapValue = swapAnalyses.reduce(
      (sum, s) => sum + s.totalSwapValue,
      0
    );
    const avgSwapEfficiency =
      swapAnalyses.length > 0
        ? swapAnalyses.reduce((sum, s) => sum + s.swapEfficiency, 0) /
          swapAnalyses.length
        : 0;
    const roundTripsAvoided = swapAnalyses.filter(
      (s) => s.avoidedRoundTrips
    ).length;

    return {
      timestamp,
      timestampISO: new Date(timestamp).toISOString(),
      totalPositions,
      activePositions,
      inRangePositions,
      outOfRangePositions,
      totalLiquidity: positionSnapshots
        .reduce((sum, p) => sum + BigInt(p.liquidity.amount), 0n)
        .toString(),
      totalValueUSD,
      totalFeesUSD,
      averageTickWidth:
        totalPositions > 0
          ? positionSnapshots.reduce(
              (sum, p) => sum + p.tickRange.tickWidth,
              0
            ) / totalPositions
          : 0,
      positionDistribution: {
        below: belowRange,
        inRange: inRangePositions,
        above: aboveRange,
      },
      performanceMetrics: {
        avgUnrealizedPnL:
          totalPositions > 0 ? totalUnrealizedPnL / totalPositions : 0,
        avgUnrealizedPnLPct:
          totalPositions > 0
            ? positionSnapshots.reduce(
                (sum, p) => sum + p.performance.unrealizedPnLPct,
                0
              ) / totalPositions
            : 0,
        avgRealizedPnL:
          totalPositions > 0 ? totalRealizedPnL / totalPositions : 0,
        avgFeeYield:
          totalPositions > 0
            ? positionSnapshots.reduce(
                (sum, p) => sum + p.performance.feeYield,
                0
              ) / totalPositions
            : 0,
        avgFeeYieldAPR:
          totalPositions > 0
            ? positionSnapshots.reduce(
                (sum, p) => sum + p.fees.feeYieldAPR,
                0
              ) / totalPositions
            : 0,
        avgTimeInRange:
          totalPositions > 0
            ? positionSnapshots.reduce(
                (sum, p) => sum + p.performance.timeInRange,
                0
              ) / totalPositions
            : 0,
        avgTimeInRangePct:
          totalPositions > 0
            ? positionSnapshots.reduce(
                (sum, p) => sum + p.performance.timeInRangePct,
                0
              ) / totalPositions
            : 0,
        totalImpermanentLoss,
        totalImpermanentLossPct:
          totalHoldingValue > 0
            ? (totalImpermanentLoss / totalHoldingValue) * 100
            : 0,
        avgROI:
          totalPositions > 0
            ? positionSnapshots.reduce((sum, p) => sum + p.performance.roi, 0) /
              totalPositions
            : 0,
        avgSharpeRatio:
          totalPositions > 0
            ? positionSnapshots.reduce(
                (sum, p) => sum + p.performance.sharpeRatio,
                0
              ) / totalPositions
            : 0,
        totalReturn,
        totalReturnPct:
          totalValueUSD > 0 ? (totalReturn / totalValueUSD) * 100 : 0,
      },
      riskMetrics: {
        portfolioVolatility,
        maxDrawdown,
        valueAtRisk,
        expectedShortfall,
      },
      optimizationAnalysis: {
        totalSwapOpportunities,
        totalSwapValue,
        avgSwapEfficiency,
        roundTripsAvoided,
      },
    };
  }

  // Helper methods (implementations would be more detailed in real scenario)
  private getAllPositions(): VirtualPosition[] {
    // Get all positions from position manager
    return this.positionManager.getAllPositions();
  }

  private generatePositionId(position: VirtualPosition): string {
    return `${position.tickLower}_${position.tickUpper}_${position.liquidity
      .toString()
      .slice(-8)}`;
  }

  private calculateTokenValue(amount: bigint, token: "A" | "B"): number {
    const price = this.calculateTokenPrice(token);
    const normalizedAmount = Number(amount) / 1e6; // Assuming 6 decimals
    return normalizedAmount * price;
  }

  private calculateTokenPrice(token: "A" | "B"): number {
    // Enhanced price calculation from pool state
    const currentTick = (this.pool as any).tickCurrent || 0;
    const basePrice = Math.pow(1.0001, currentTick);

    if (token === "A") {
      // Token A (e.g., SUI) price calculation
      return basePrice;
    } else {
      // Token B (e.g., USDC) price - typically stable
      return 1.0;
    }
  }

  private calculateAccruedFees(
    position: VirtualPosition,
    tokenIndex: 0 | 1
  ): bigint {
    // Enhanced fee calculation based on fee growth
    const poolFeeGrowthGlobal =
      tokenIndex === 0
        ? (this.pool as any).feeGrowthGlobal0X64 || 0n
        : (this.pool as any).feeGrowthGlobal1X64 || 0n;

    const positionFeeGrowthInside =
      tokenIndex === 0
        ? position.feeGrowthInside0LastX64
        : position.feeGrowthInside1LastX64;

    const feeGrowthDelta = poolFeeGrowthGlobal - positionFeeGrowthInside;
    const accruedFees = (position.liquidity * feeGrowthDelta) / 2n ** 64n;

    return accruedFees > 0n ? accruedFees : 0n;
  }

  private calculateTotalFeesUSD(position: VirtualPosition): number {
    const fees0USD = this.calculateTokenValue(
      this.calculateAccruedFees(position, 0),
      "A"
    );
    const fees1USD = this.calculateTokenValue(
      this.calculateAccruedFees(position, 1),
      "B"
    );
    return fees0USD + fees1USD;
  }

  private calculateUnrealizedPnL(position: VirtualPosition): number {
    const currentValue =
      this.calculateTokenValue(position.tokensOwed0, "A") +
      this.calculateTokenValue(position.tokensOwed1, "B");
    const initialValue = this.getPositionInitialValue(position);
    return currentValue - initialValue;
  }

  private calculateRealizedPnL(position: VirtualPosition): number {
    // Calculate realized PnL from fees collected
    return this.calculateTotalFeesUSD(position);
  }

  private calculateFeeYield(position: VirtualPosition): number {
    const totalFees = this.calculateTotalFeesUSD(position);
    const initialValue = this.getPositionInitialValue(position);
    return initialValue > 0 ? (totalFees / initialValue) * 100 : 0;
  }

  private calculateFeeYieldAPR(position: VirtualPosition): number {
    const feeYield = this.calculateFeeYield(position);
    const positionAge = this.getPositionAge(position);
    const daysActive = positionAge / (24 * 60 * 60 * 1000);
    return daysActive > 0 ? (feeYield * 365) / daysActive : 0;
  }

  private calculateFeeYieldDaily(position: VirtualPosition): number {
    const apr = this.calculateFeeYieldAPR(position);
    return apr / 365;
  }

  private calculateROI(position: VirtualPosition): number {
    const unrealizedPnL = this.calculateUnrealizedPnL(position);
    const realizedPnL = this.calculateRealizedPnL(position);
    const totalReturn = unrealizedPnL + realizedPnL;
    const initialValue = this.getPositionInitialValue(position);
    return initialValue > 0 ? (totalReturn / initialValue) * 100 : 0;
  }

  private calculateSharpeRatio(position: VirtualPosition): number {
    // Simplified Sharpe ratio calculation
    const roi = this.calculateROI(position);
    const volatility = this.calculateVolatility(position);
    const riskFreeRate = 3; // Assume 3% risk-free rate

    return volatility > 0 ? (roi - riskFreeRate) / volatility : 0;
  }

  private calculateVolatility(position: VirtualPosition): number {
    // Calculate price volatility for the position range
    const lowerPrice = this.tickToPrice(position.tickLower);
    const upperPrice = this.tickToPrice(position.tickUpper);
    const currentPrice = this.getCurrentPrice();

    const priceRange = upperPrice - lowerPrice;
    const midPrice = (upperPrice + lowerPrice) / 2;

    return midPrice > 0 ? (priceRange / midPrice) * 100 : 0;
  }

  private getPositionInitialValue(position: VirtualPosition): number {
    // This would need to be stored when position is created
    // For now, estimate based on current liquidity and price range
    const midPrice =
      (this.tickToPrice(position.tickLower) +
        this.tickToPrice(position.tickUpper)) /
      2;
    const estimatedValue = (Number(position.liquidity) / 1e18) * midPrice; // Rough estimate
    return estimatedValue;
  }

  private getPositionAge(position: VirtualPosition): number {
    const positionId = this.generatePositionId(position);
    const startTime = this.positionStartTimes.get(positionId) || Date.now();
    return Date.now() - startTime;
  }

  private getTimeInRange(
    position: VirtualPosition,
    currentTime: number
  ): number {
    const positionId = this.generatePositionId(position);
    return this.positionInRangeTimes.get(positionId) || 0;
  }

  private getTimeOutOfRange(
    position: VirtualPosition,
    currentTime: number
  ): number {
    const positionId = this.generatePositionId(position);
    const startTime = this.positionStartTimes.get(positionId) || currentTime;
    const totalTime = currentTime - startTime;
    const timeInRange = this.positionInRangeTimes.get(positionId) || 0;
    return Math.max(0, totalTime - timeInRange);
  }

  private getCurrentPrice(): number {
    // Enhanced current price calculation from pool state
    const sqrtPriceX64 = (this.pool as any).sqrtPriceX64 || 0n;
    if (sqrtPriceX64 === 0n) return 1.0;

    // Convert sqrtPriceX64 to actual price
    const sqrtPrice = Number(sqrtPriceX64) / 2 ** 64;
    const price = sqrtPrice * sqrtPrice;

    return price;
  }

  private tickToPrice(tick: number): number {
    // Implementation to convert tick to price
    return Math.pow(1.0001, tick); // Placeholder
  }

  private getPricePosition(
    position: VirtualPosition
  ): "below" | "in_range" | "above" {
    const currentTick = (this.pool as any).tickCurrent || 0;
    if (currentTick < position.tickLower) return "below";
    if (currentTick >= position.tickUpper) return "above";
    return "in_range";
  }

  private getDistanceFromRange(position: VirtualPosition): number {
    const currentTick = (this.pool as any).tickCurrent || 0;
    if (currentTick < position.tickLower) {
      return position.tickLower - currentTick;
    }
    if (currentTick >= position.tickUpper) {
      return currentTick - position.tickUpper;
    }
    return 0; // In range
  }

  private calculateLiquidityUtilization(position: VirtualPosition): number {
    return 0; // Placeholder
  }

  private calculateCapitalEfficiency(position: VirtualPosition): number {
    const totalFees = this.calculateTotalFeesUSD(position);
    const totalValue =
      this.calculateTokenValue(position.tokensOwed0, "A") +
      this.calculateTokenValue(position.tokensOwed1, "B");

    // Capital efficiency = fees earned / capital deployed
    return totalValue > 0 ? (totalFees / totalValue) * 100 : 0;
  }

  /**
   * Analyze swap opportunities for position optimization
   */
  private analyzeSwapOpportunities(position: VirtualPosition): {
    optimalSwaps: SwapPlan[];
    totalSwapValue: number;
    swapEfficiency: number;
    avoidedRoundTrips: boolean;
  } {
    const swaps: SwapPlan[] = [];
    const currentTick = (this.pool as any).tickCurrent || 0;
    const inRange =
      currentTick >= position.tickLower && currentTick < position.tickUpper;

    // If position is out of range, suggest rebalancing swaps
    if (!inRange) {
      const value0 = this.calculateTokenValue(position.tokensOwed0, "A");
      const value1 = this.calculateTokenValue(position.tokensOwed1, "B");
      const totalValue = value0 + value1;

      if (currentTick < position.tickLower) {
        // Price below range - mostly token1, suggest swap to token0
        if (value1 > totalValue * 0.1) {
          swaps.push({
            fromToken: "tokenB",
            toToken: "tokenA",
            swapValueUSD: value1 * 0.5,
            swapAmountFrom: value1 * 0.5,
            swapAmountTo: (value1 * 0.5) / this.calculateTokenPrice("A"),
            reason: "Rebalance for range entry",
            routingType: "optimal",
            efficiency: 0.95,
          });
        }
      } else if (currentTick >= position.tickUpper) {
        // Price above range - mostly token0, suggest swap to token1
        if (value0 > totalValue * 0.1) {
          swaps.push({
            fromToken: "tokenA",
            toToken: "tokenB",
            swapValueUSD: value0 * 0.5,
            swapAmountFrom: value0 * 0.5,
            swapAmountTo: value0 * 0.5, // Assuming USDC
            reason: "Rebalance for range entry",
            routingType: "optimal",
            efficiency: 0.95,
          });
        }
      }
    }

    const totalSwapValue = swaps.reduce(
      (sum, swap) => sum + swap.swapValueUSD,
      0
    );
    const avgEfficiency =
      swaps.length > 0
        ? swaps.reduce((sum, swap) => sum + swap.efficiency, 0) / swaps.length
        : 0;

    return {
      optimalSwaps: swaps,
      totalSwapValue,
      swapEfficiency: avgEfficiency,
      avoidedRoundTrips: swaps.every((swap) => swap.routingType === "optimal"),
    };
  }

  /**
   * Calculate portfolio-level volatility
   */
  private calculatePortfolioVolatility(positions: PositionSnapshot[]): number {
    if (positions.length === 0) return 0;

    const volatilities = positions.map((p) => p.priceInfo.volatility);
    const weights = positions.map((p) => p.tokens.totalValueUSD);
    const totalValue = weights.reduce((sum, w) => sum + w, 0);

    if (totalValue === 0) return 0;

    // Weighted average volatility
    const weightedVolatility = volatilities.reduce((sum, vol, i) => {
      const weight = weights[i] || 0;
      return sum + (vol * weight) / totalValue;
    }, 0);

    return weightedVolatility;
  }

  /**
   * Calculate maximum drawdown
   */
  private calculateMaxDrawdown(): number {
    if (this.summarySnapshots.length < 2) return 0;

    let maxDrawdown = 0;
    let peak = this.summarySnapshots[0]!.totalValueUSD;

    for (const snapshot of this.summarySnapshots) {
      if (snapshot.totalValueUSD > peak) {
        peak = snapshot.totalValueUSD;
      }

      const drawdown = (peak - snapshot.totalValueUSD) / peak;
      if (drawdown > maxDrawdown) {
        maxDrawdown = drawdown;
      }
    }

    return maxDrawdown * 100; // Return as percentage
  }

  /**
   * Calculate Value at Risk (95% confidence)
   */
  private calculateValueAtRisk(positions: PositionSnapshot[]): number {
    if (positions.length === 0) return 0;

    const returns = positions.map((p) => p.performance.totalReturnPct);
    returns.sort((a, b) => a - b);

    const varIndex = Math.floor(returns.length * 0.05); // 5th percentile
    return returns[varIndex] || 0;
  }

  /**
   * Calculate Expected Shortfall (Conditional VaR)
   */
  private calculateExpectedShortfall(positions: PositionSnapshot[]): number {
    if (positions.length === 0) return 0;

    const returns = positions.map((p) => p.performance.totalReturnPct);
    returns.sort((a, b) => a - b);

    const varIndex = Math.floor(returns.length * 0.05);
    const tailReturns = returns.slice(0, varIndex);

    if (tailReturns.length === 0) return 0;

    return tailReturns.reduce((sum, ret) => sum + ret, 0) / tailReturns.length;
  }

  private calculateImpermanentLoss(position: VirtualPosition): number {
    const currentPrice = this.getCurrentPrice();
    const entryPrice = this.getPositionEntryPrice(position);

    if (entryPrice === 0) return 0;

    const priceRatio = currentPrice / entryPrice;
    const sqrtPriceRatio = Math.sqrt(priceRatio);

    // IL formula: 2 * sqrt(price_ratio) / (1 + price_ratio) - 1
    const impermanentLoss = (2 * sqrtPriceRatio) / (1 + priceRatio) - 1;

    // Convert to USD value
    const positionValue =
      this.calculateTokenValue(position.tokensOwed0, "A") +
      this.calculateTokenValue(position.tokensOwed1, "B");

    return impermanentLoss * positionValue;
  }

  private calculateHoldingValue(position: VirtualPosition): number {
    // Calculate what the position would be worth if just holding tokens
    const entryPrice = this.getPositionEntryPrice(position);
    const currentPrice = this.getCurrentPrice();

    if (entryPrice === 0) return 0;

    const initialValue0 = this.calculateTokenValue(position.tokensOwed0, "A");
    const initialValue1 = this.calculateTokenValue(position.tokensOwed1, "B");

    // Simulate holding the initial tokens at current prices
    const holdingValue =
      (initialValue0 * currentPrice) / entryPrice + initialValue1;

    return holdingValue;
  }

  private getPositionEntryPrice(position: VirtualPosition): number {
    // Get the price when position was created - this would need to be stored
    // For now, use tick range midpoint as approximation
    const midTick = (position.tickLower + position.tickUpper) / 2;
    return Math.pow(1.0001, midTick);
  }

  private updateTimeTracking(
    positionId: string,
    snapshot: PositionSnapshot,
    timestamp: number
  ): void {
    if (snapshot.liquidity.inRange) {
      const currentInRangeTime = this.positionInRangeTimes.get(positionId) || 0;
      this.positionInRangeTimes.set(
        positionId,
        currentInRangeTime + this.snapshotInterval
      );
    }
  }

  /**
   * Save snapshots to CSV files
   */
  public saveSnapshots(filename?: string): void {
    const timestamp = Date.now();
    const baseFilename = filename
      ? filename.replace(".json", "")
      : `position_snapshots_${timestamp}`;

    // Save position details (CSV)
    const positionCsvFile = `${baseFilename}_positions.csv`;
    const positionCsvPath = path.join(this.outputDir, positionCsvFile);
    this.savePositionSnapshotsAsCSV(positionCsvPath);
    console.log(`📊 Position snapshots (CSV) saved to: ${positionCsvPath}`);

    // Save summary (CSV)
    const summaryCsvFile = `${baseFilename}_summary.csv`;
    const summaryCsvPath = path.join(this.outputDir, summaryCsvFile);
    this.saveSummarySnapshotsAsCSV(summaryCsvPath);
    console.log(`📊 Position summary (CSV) saved to: ${summaryCsvPath}`);
  }

  /**
   * Export position snapshots to CSV file
   */
  private savePositionSnapshotsAsCSV(csvPath: string): void {
    const allSnapshots: PositionSnapshot[] = [];

    // Flatten all position snapshots
    for (const [positionId, snapshots] of this.positionSnapshots) {
      allSnapshots.push(...snapshots);
    }

    if (allSnapshots.length === 0) return;

    const headers = [
      "timestamp",
      "position_id",
      "vault_id",
      "event_type",
      "action_type",
      "pool_address",
      "min_price",
      "max_price",
      "inner_min_price",
      "inner_max_price",
      "current_price",
      "position_width_percentage",
      "token_a_amount",
      "token_b_amount",
      "current_liquidity_usd",
      "start_liquidity_usd",
      "fee_earned",
      "position_return_usd",
      "position_return_percentage",
      "il",
      "apr",
      "trigger_reason",
      "ai_explanation",
      "confidence_score",
      "rebalance_action",
      "rebalance_amount",
    ];

    const csvRows = [headers.join(",")];

    for (const snapshot of allSnapshots) {
      // Calculate derived values to match sample format
      const vaultId = "unknown";
      const eventType = snapshot.liquidity.isActive ? "REGULAR" : "CLOSE";
      const actionType = snapshot.liquidity.isActive ? "" : "CLOSE_POSITION";
      const poolAddress = "unknown";
      const minPrice = snapshot.priceInfo.lowerPrice;
      const maxPrice = snapshot.priceInfo.upperPrice;
      const currentPrice = snapshot.priceInfo.currentPrice;
      const positionWidthPercentage =
        ((maxPrice - minPrice) / currentPrice) * 100;
      const tokenAAmount = parseFloat(snapshot.tokens.amount0.toString());
      const tokenBAmount = parseFloat(snapshot.tokens.amount1.toString());
      const currentLiquidityUSD = snapshot.tokens.totalValueUSD;
      const startLiquidityUSD = snapshot.tokens.totalValueUSD; // Would need to track initial value
      const feeEarned = snapshot.fees.totalFeesUSD;
      const positionReturnUSD = snapshot.performance.totalReturn;
      const positionReturnPercentage = snapshot.performance.totalReturnPct;
      const il = snapshot.utilization.impermanentLossPct;
      const apr = snapshot.fees.feeYieldAPR;
      const triggerReason = snapshot.liquidity.inRange
        ? "Regular update position state"
        : "Out of range";
      const aiExplanation = snapshot.liquidity.inRange
        ? ""
        : "Position out of range";
      const confidenceScore = 0.0;
      const rebalanceAction = "";
      const rebalanceAmount = 0.0;

      const row = [
        `"${snapshot.timestampISO}"`, // timestamp
        snapshot.positionId, // position_id
        `"${vaultId}"`, // vault_id
        `"${eventType}"`, // event_type
        `"${actionType}"`, // action_type
        `"${poolAddress}"`, // pool_address
        minPrice, // min_price
        maxPrice, // max_price
        currentPrice, // current_price
        positionWidthPercentage, // position_width_percentage
        tokenAAmount, // token_a_amount
        tokenBAmount, // token_b_amount
        currentLiquidityUSD, // current_liquidity_usd
        startLiquidityUSD, // start_liquidity_usd
        feeEarned, // fee_earned
        positionReturnUSD, // position_return_usd
        positionReturnPercentage, // position_return_percentage
        il, // il
        apr, // apr
        `"${triggerReason}"`, // trigger_reason
        `"${aiExplanation}"`, // ai_explanation
        confidenceScore, // confidence_score
        `"${rebalanceAction}"`, // rebalance_action
        rebalanceAmount, // rebalance_amount
      ];

      csvRows.push(row.join(","));
    }

    fs.writeFileSync(csvPath, csvRows.join("\n"), "utf-8");
  }

  /**
   * Export summary snapshots to CSV file
   */
  private saveSummarySnapshotsAsCSV(csvPath: string): void {
    if (this.summarySnapshots.length === 0) return;

    const headers = [
      "Timestamp",
      "TimestampISO",
      "TotalPositions",
      "ActivePositions",
      "InRangePositions",
      "OutOfRangePositions",
      "TotalLiquidity",
      "TotalValueUSD",
      "TotalFeesUSD",
      "AverageTickWidth",
      "PositionsBelow",
      "PositionsInRange",
      "PositionsAbove",
      "AvgUnrealizedPnL",
      "AvgUnrealizedPnLPct",
      "AvgRealizedPnL",
      "AvgFeeYield",
      "AvgFeeYieldAPR",
      "AvgTimeInRange",
      "AvgTimeInRangePct",
      "TotalImpermanentLoss",
      "TotalImpermanentLossPct",
      "AvgROI",
      "AvgSharpeRatio",
      "TotalReturn",
      "TotalReturnPct",
      "PortfolioVolatility",
      "MaxDrawdown",
      "ValueAtRisk",
      "ExpectedShortfall",
      "TotalSwapOpportunities",
      "TotalSwapValue",
      "AvgSwapEfficiency",
      "RoundTripsAvoided",
    ];

    const csvRows = [headers.join(",")];

    for (const snapshot of this.summarySnapshots) {
      const row = [
        snapshot.timestamp,
        `"${snapshot.timestampISO}"`,
        snapshot.totalPositions,
        snapshot.activePositions,
        snapshot.inRangePositions,
        snapshot.outOfRangePositions,
        `"${snapshot.totalLiquidity}"`,
        snapshot.totalValueUSD,
        snapshot.totalFeesUSD,
        snapshot.averageTickWidth,
        snapshot.positionDistribution.below,
        snapshot.positionDistribution.inRange,
        snapshot.positionDistribution.above,
        snapshot.performanceMetrics.avgUnrealizedPnL,
        snapshot.performanceMetrics.avgUnrealizedPnLPct,
        snapshot.performanceMetrics.avgRealizedPnL,
        snapshot.performanceMetrics.avgFeeYield,
        snapshot.performanceMetrics.avgFeeYieldAPR,
        snapshot.performanceMetrics.avgTimeInRange,
        snapshot.performanceMetrics.avgTimeInRangePct,
        snapshot.performanceMetrics.totalImpermanentLoss,
        snapshot.performanceMetrics.totalImpermanentLossPct,
        snapshot.performanceMetrics.avgROI,
        snapshot.performanceMetrics.avgSharpeRatio,
        snapshot.performanceMetrics.totalReturn,
        snapshot.performanceMetrics.totalReturnPct,
        snapshot.riskMetrics.portfolioVolatility,
        snapshot.riskMetrics.maxDrawdown,
        snapshot.riskMetrics.valueAtRisk,
        snapshot.riskMetrics.expectedShortfall,
        snapshot.optimizationAnalysis.totalSwapOpportunities,
        snapshot.optimizationAnalysis.totalSwapValue,
        snapshot.optimizationAnalysis.avgSwapEfficiency,
        snapshot.optimizationAnalysis.roundTripsAvoided,
      ];

      csvRows.push(row.join(","));
    }

    fs.writeFileSync(csvPath, csvRows.join("\n"), "utf-8");
  }

  /**
   * Create overall summary
   */
  private generateOverallSummary() {
    if (this.summarySnapshots.length === 0) return null;

    const first = this.summarySnapshots[0]!;
    const last = this.summarySnapshots[this.summarySnapshots.length - 1]!;

    return {
      duration: {
        start: first.timestampISO,
        end: last.timestampISO,
        durationMs: last.timestamp - first.timestamp,
        durationDays:
          (last.timestamp - first.timestamp) / (24 * 60 * 60 * 1000),
      },
      positionStats: {
        maxPositions: Math.max(
          ...this.summarySnapshots.map((s) => s.totalPositions)
        ),
        minPositions: Math.min(
          ...this.summarySnapshots.map((s) => s.totalPositions)
        ),
        avgPositions:
          this.summarySnapshots.reduce((sum, s) => sum + s.totalPositions, 0) /
          this.summarySnapshots.length,
        avgInRangePositions:
          this.summarySnapshots.reduce(
            (sum, s) => sum + s.inRangePositions,
            0
          ) / this.summarySnapshots.length,
        avgInRangePercentage:
          this.summarySnapshots.reduce(
            (sum, s) =>
              sum +
              (s.totalPositions > 0
                ? (s.inRangePositions / s.totalPositions) * 100
                : 0),
            0
          ) / this.summarySnapshots.length,
      },
      valueStats: {
        maxValue: Math.max(
          ...this.summarySnapshots.map((s) => s.totalValueUSD)
        ),
        minValue: Math.min(
          ...this.summarySnapshots.map((s) => s.totalValueUSD)
        ),
        avgValue:
          this.summarySnapshots.reduce((sum, s) => sum + s.totalValueUSD, 0) /
          this.summarySnapshots.length,
        totalFees: last.totalFeesUSD,
      },
      performanceStats: {
        avgUnrealizedPnL:
          this.summarySnapshots.reduce(
            (sum, s) => sum + s.performanceMetrics.avgUnrealizedPnL,
            0
          ) / this.summarySnapshots.length,
        avgFeeYield:
          this.summarySnapshots.reduce(
            (sum, s) => sum + s.performanceMetrics.avgFeeYield,
            0
          ) / this.summarySnapshots.length,
        avgTimeInRange:
          this.summarySnapshots.reduce(
            (sum, s) => sum + s.performanceMetrics.avgTimeInRange,
            0
          ) / this.summarySnapshots.length,
        totalImpermanentLoss: last.performanceMetrics.totalImpermanentLoss,
      },
    };
  }

  /**
   * Get snapshots for a specific position
   */
  public getPositionSnapshots(positionId: string): PositionSnapshot[] {
    return this.positionSnapshots.get(positionId) || [];
  }

  /**
   * Get all summary snapshots
   */
  public getSummarySnapshots(): PositionSummarySnapshot[] {
    return [...this.summarySnapshots];
  }

  /**
   * Clear all snapshots
   */
  public clearSnapshots(): void {
    this.positionSnapshots.clear();
    this.summarySnapshots = [];
    this.positionStartTimes.clear();
    this.positionInRangeTimes.clear();
    this.lastSnapshotTime = 0;
  }
}
