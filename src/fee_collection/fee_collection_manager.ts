/**
 * Enhanced Fee Collection Manager
 * Provides reusable fee collection and reinvestment functionality for any strategy
 */

import type {
  FeeCollectionConfig,
  PositionProfitability,
  FeeCollectionEvent,
  ReinvestmentEvent,
  FeeCollectionAnalytics,
  PositionManager,
  PriceProvider,
  FeeCollectionAction,
  FeeCollectionState,
  CustomReinvestmentStrategy,
} from "./types";

export class FeeCollectionManager {
  private config: Required<FeeCollectionConfig>;
  private state: FeeCollectionState;
  private positionManager: PositionManager;
  private priceProvider: PriceProvider;

  constructor(
    positionManager: PositionManager,
    priceProvider: PriceProvider,
    config: FeeCollectionConfig = {}
  ) {
    this.positionManager = positionManager;
    this.priceProvider = priceProvider;

    // Set default configuration
    this.config = {
      enablePeriodicFeeCollection: config.enablePeriodicFeeCollection ?? true,
      feeCollectionIntervalMs: config.feeCollectionIntervalMs ?? 3600000, // 1 hour
      feeCollectionThresholdPercent:
        config.feeCollectionThresholdPercent ?? 0.5,
      enableSmartReinvestment: config.enableSmartReinvestment ?? true,
      reinvestmentStrategy: config.reinvestmentStrategy ?? "most_profitable",
      profitabilityWindowMs: config.profitabilityWindowMs ?? 86400000, // 24 hours
      minReinvestmentAmount: config.minReinvestmentAmount ?? 1.0,
      maxReinvestmentPerPosition: config.maxReinvestmentPerPosition ?? 1000000,
      reinvestmentCooldownMs: config.reinvestmentCooldownMs ?? 300000, // 5 minutes
      enableRiskManagement: config.enableRiskManagement ?? true,
      maxPositionConcentration: config.maxPositionConcentration ?? 0.4, // 40%
      enableDetailedAnalytics: config.enableDetailedAnalytics ?? true,
      analyticsRetentionDays: config.analyticsRetentionDays ?? 30,
      enablePerformanceTracking: config.enablePerformanceTracking ?? true,
    };

    // Initialize state
    this.state = {
      lastFeeCollection: Date.now(),
      lastReinvestment: Date.now(),
      positionProfitabilityHistory: new Map(),
      feeCollectionHistory: [],
      reinvestmentHistory: [],
      customStrategies: new Map(),
    };
  }

  /**
   * Update configuration at runtime
   */
  updateConfig(newConfig: Partial<FeeCollectionConfig>) {
    this.config = { ...this.config, ...newConfig };
  }

  /**
   * Register a custom reinvestment strategy
   */
  registerCustomStrategy(strategy: CustomReinvestmentStrategy) {
    this.state.customStrategies.set(strategy.name, strategy);
  }

  /**
   * Main execution method - call this from your strategy's execute() method
   */
  execute(currentTime: number = Date.now()): FeeCollectionAction {
    // Clean up old data
    this.cleanupOldData(currentTime);

    // Update position profitability tracking
    this.updatePositionProfitability(currentTime);

    // Check for fee collection
    if (
      this.config.enablePeriodicFeeCollection &&
      this.shouldCollectFees(currentTime)
    ) {
      return this.collectAllFees(currentTime);
    }

    // Check for reinvestment
    if (
      this.config.enableSmartReinvestment &&
      this.shouldReinvest(currentTime)
    ) {
      return this.reinvestCollectedFees(currentTime);
    }

    return {
      action: "none",
      message: "No fee collection or reinvestment needed",
    };
  }

  /**
   * Check if fees should be collected
   */
  private shouldCollectFees(currentTime: number): boolean {
    const timeSinceLastCollection = currentTime - this.state.lastFeeCollection;

    // Check interval
    if (timeSinceLastCollection < this.config.feeCollectionIntervalMs) {
      return false;
    }

    // Check threshold
    const totals = this.positionManager.getTotals();
    const unclaimedFees = totals.feesOwed0 + totals.feesOwed1;
    const totalValue = totals.amountA + totals.amountB;

    if (totalValue === 0n) {
      return false;
    }

    const threshold =
      (totalValue *
        BigInt(Math.floor(this.config.feeCollectionThresholdPercent * 100))) /
      10000n;
    return unclaimedFees > threshold;
  }

  /**
   * Collect fees from all positions
   */
  private collectAllFees(currentTime: number): FeeCollectionAction {
    let totalFee0 = 0n;
    let totalFee1 = 0n;
    const positionFees = new Map<string, { fee0: bigint; fee1: bigint }>();
    const positionsAffected: string[] = [];

    // Get all active positions
    const positions = this.positionManager.getActivePositions();

    for (const position of positions) {
      try {
        const fees = this.positionManager.collectFees(position.id);
        if (fees && (fees.fee0 > 0n || fees.fee1 > 0n)) {
          totalFee0 += fees.fee0;
          totalFee1 += fees.fee1;
          positionFees.set(position.id, fees);
          positionsAffected.push(position.id);
        }
      } catch (err) {
        console.warn(
          `Failed to collect fees from position ${position.id}:`,
          err
        );
      }
    }

    // Record fee collection event
    const feeEvent: FeeCollectionEvent = {
      timestamp: currentTime,
      totalFees0: totalFee0,
      totalFees1: totalFee1,
      positionFees,
      triggerReason: "interval",
    };

    this.state.feeCollectionHistory.push(feeEvent);
    this.state.lastFeeCollection = currentTime;

    return {
      action: "collect_fees",
      message: `Collected fees: ${Number(totalFee0)} token0 + ${Number(
        totalFee1
      )} token1 from ${positionsAffected.length} positions`,
      feesCollected: { fee0: totalFee0, fee1: totalFee1 },
      positionsAffected,
    };
  }

  /**
   * Check if collected fees should be reinvested
   */
  private shouldReinvest(currentTime: number): boolean {
    const timeSinceLastReinvestment = currentTime - this.state.lastReinvestment;

    // Check cooldown
    if (timeSinceLastReinvestment < this.config.reinvestmentCooldownMs) {
      return false;
    }

    // Check available cash
    const totals = this.positionManager.getTotals();
    const currentPrice = this.priceProvider.getCurrentPrice();
    const cashValueInToken1 =
      Number(totals.amountB) + Number(totals.amountA) * currentPrice;

    return cashValueInToken1 >= this.config.minReinvestmentAmount;
  }

  /**
   * Reinvest collected fees into the best position
   */
  private reinvestCollectedFees(currentTime: number): FeeCollectionAction {
    const totals = this.positionManager.getTotals();
    const availableA = totals.amountA;
    const availableB = totals.amountB;

    // Get position profitability data
    const positions = this.getAllPositionProfitability(currentTime);

    if (positions.length === 0) {
      return {
        action: "none",
        message: "No positions available for reinvestment",
      };
    }

    // Select target position based on strategy
    const targetPositionId = this.selectTargetPosition(
      positions,
      availableA,
      availableB
    );

    if (!targetPositionId) {
      return {
        action: "none",
        message: "No suitable position found for reinvestment",
      };
    }

    // Apply risk management checks
    if (
      this.config.enableRiskManagement &&
      !this.passesRiskChecks(targetPositionId, availableA, availableB)
    ) {
      return {
        action: "none",
        message: "Reinvestment blocked by risk management rules",
      };
    }

    try {
      // Execute reinvestment
      const result = this.positionManager.addToPosition(
        targetPositionId,
        availableA,
        availableB
      );

      // Find target position profitability for scoring
      const targetPosition = positions.find(
        (p) => p.positionId === targetPositionId
      );

      // Record reinvestment event
      const reinvestmentEvent: ReinvestmentEvent = {
        timestamp: currentTime,
        targetPosition: targetPositionId,
        amount0: availableA,
        amount1: availableB,
        reason: `${this.config.reinvestmentStrategy} strategy`,
        strategy: this.config.reinvestmentStrategy,
        profitabilityScore: targetPosition?.profitabilityScore ?? 0,
      };

      this.state.reinvestmentHistory.push(reinvestmentEvent);
      this.state.lastReinvestment = currentTime;

      return {
        action: "reinvest",
        message: `Reinvested ${Number(availableA)} token0 + ${Number(
          availableB
        )} token1 into position ${targetPositionId}`,
        reinvestmentDetails: reinvestmentEvent,
      };
    } catch (err) {
      return {
        action: "none",
        message: `Failed to reinvest into position ${targetPositionId}: ${
          (err as Error).message
        }`,
      };
    }
  }

  /**
   * Select target position for reinvestment based on strategy
   */
  private selectTargetPosition(
    positions: PositionProfitability[],
    availableA: bigint,
    availableB: bigint
  ): string | null {
    switch (this.config.reinvestmentStrategy) {
      case "most_profitable":
        return this.selectMostProfitablePosition(positions);

      case "balanced":
        return this.selectBalancedPosition(positions);

      case "active_range":
        return this.selectActiveRangePosition(positions);

      case "custom":
        return this.selectCustomPosition(positions, availableA, availableB);

      default:
        return this.selectMostProfitablePosition(positions);
    }
  }

  /**
   * Select the most profitable position
   */
  private selectMostProfitablePosition(
    positions: PositionProfitability[]
  ): string | null {
    if (positions.length === 0) return null;

    const best = positions.reduce((best, current) =>
      current.profitabilityScore > best.profitabilityScore ? current : best
    );

    return best.positionId;
  }

  /**
   * Select position for balanced reinvestment
   */
  private selectBalancedPosition(
    positions: PositionProfitability[]
  ): string | null {
    if (positions.length === 0) return null;

    // Find position with lowest recent reinvestment
    const recentReinvestments = this.state.reinvestmentHistory
      .filter(
        (event) =>
          Date.now() - event.timestamp < this.config.profitabilityWindowMs
      )
      .reduce((acc, event) => {
        acc[event.targetPosition] = (acc[event.targetPosition] || 0) + 1;
        return acc;
      }, {} as Record<string, number>);

    // Sort by profitability, then by least recent reinvestments
    const sorted = positions.sort((a, b) => {
      const aReinvestments = recentReinvestments[a.positionId] || 0;
      const bReinvestments = recentReinvestments[b.positionId] || 0;

      if (aReinvestments !== bReinvestments) {
        return aReinvestments - bReinvestments; // Prefer less reinvested
      }

      return b.profitabilityScore - a.profitabilityScore; // Then by profitability
    });

    return sorted[0].positionId;
  }

  /**
   * Select position currently in active range
   */
  private selectActiveRangePosition(
    positions: PositionProfitability[]
  ): string | null {
    const inRangePositions = positions.filter((p) => p.isInRange);

    if (inRangePositions.length === 0) {
      // Fallback to most profitable if none in range
      return this.selectMostProfitablePosition(positions);
    }

    return this.selectMostProfitablePosition(inRangePositions);
  }

  /**
   * Select position using custom strategy
   */
  private selectCustomPosition(
    positions: PositionProfitability[],
    availableA: bigint,
    availableB: bigint
  ): string | null {
    // Try to find a custom strategy that matches the current config
    for (const [name, strategy] of this.state.customStrategies) {
      if (name === this.config.reinvestmentStrategy) {
        return strategy.selectTargetPosition(
          positions,
          availableA,
          availableB,
          {
            currentPrice: this.priceProvider.getCurrentPrice(),
            currentTick: this.priceProvider.getCurrentTick(),
          }
        );
      }
    }

    // Fallback to most profitable
    return this.selectMostProfitablePosition(positions);
  }

  /**
   * Apply risk management checks
   */
  private passesRiskChecks(
    targetPositionId: string,
    amount0: bigint,
    amount1: bigint
  ): boolean {
    if (!this.config.enableRiskManagement) return true;

    // Check position concentration
    const totals = this.positionManager.getTotals();
    const totalValue = Number(totals.amountA + totals.amountB);
    const reinvestmentValue = Number(amount0 + amount1);

    if (totalValue > 0) {
      const concentrationRatio = reinvestmentValue / totalValue;
      if (concentrationRatio > this.config.maxPositionConcentration) {
        return false;
      }
    }

    // Check maximum reinvestment per position
    const currentPrice = this.priceProvider.getCurrentPrice();
    const reinvestmentValueInToken1 =
      Number(amount1) + Number(amount0) * currentPrice;

    if (reinvestmentValueInToken1 > this.config.maxReinvestmentPerPosition) {
      return false;
    }

    return true;
  }

  /**
   * Update position profitability tracking
   */
  private updatePositionProfitability(currentTime: number) {
    const positions = this.positionManager.getActivePositions();
    const currentTick = this.priceProvider.getCurrentTick();
    const currentPrice = this.priceProvider.getCurrentPrice();

    for (const position of positions) {
      const profitability = this.calculatePositionProfitability(
        position,
        currentTime,
        currentTick,
        currentPrice
      );

      // Store in history
      let history = this.state.positionProfitabilityHistory.get(position.id);
      if (!history) {
        history = [];
        this.state.positionProfitabilityHistory.set(position.id, history);
      }

      history.push(profitability);

      // Keep only recent history
      const cutoffTime = currentTime - this.config.profitabilityWindowMs;
      history = history.filter(
        (entry) => (entry as any).timestamp > cutoffTime
      );
      this.state.positionProfitabilityHistory.set(position.id, history);
    }
  }

  /**
   * Calculate profitability metrics for a position
   */
  private calculatePositionProfitability(
    position: any,
    currentTime: number,
    currentTick: number,
    currentPrice: number
  ): PositionProfitability & { timestamp: number } {
    // Calculate if position is currently in range
    const isInRange =
      currentTick >= position.tickLower && currentTick < position.tickUpper;

    // Calculate fee rates (simplified - would need actual fee tracking)
    const timeElapsed =
      Math.max(1, currentTime - position.createdAt) / (1000 * 60 * 60); // hours
    const feeRate0 = 0; // Would need actual fee tracking
    const feeRate1 = 0; // Would need actual fee tracking

    // Convert to token1 equivalent value
    const totalFeeValue = feeRate1 + feeRate0 * currentPrice;

    // Calculate time in range from history
    const history =
      this.state.positionProfitabilityHistory.get(position.id) ?? [];
    const timeInRange =
      history.length > 0
        ? history.filter((h) => h.isInRange).length / history.length
        : isInRange
        ? 1
        : 0;

    // Calculate liquidity utilization (simplified)
    const liquidityUtilization = 0.5; // Would need actual pool data

    // Calculate overall profitability score
    const profitabilityScore =
      totalFeeValue * timeInRange * Math.min(1, liquidityUtilization * 2);

    return {
      positionId: position.id,
      feeRate0,
      feeRate1,
      totalFeeValue,
      profitabilityScore,
      isInRange,
      timeInRange,
      liquidityUtilization,
      timestamp: currentTime,
    };
  }

  /**
   * Get all position profitability data
   */
  private getAllPositionProfitability(
    currentTime: number
  ): PositionProfitability[] {
    const positions = this.positionManager.getActivePositions();
    const currentTick = this.priceProvider.getCurrentTick();
    const currentPrice = this.priceProvider.getCurrentPrice();

    return positions.map((position) =>
      this.calculatePositionProfitability(
        position,
        currentTime,
        currentTick,
        currentPrice
      )
    );
  }

  /**
   * Clean up old data to prevent memory leaks
   */
  private cleanupOldData(currentTime: number) {
    const retentionMs =
      this.config.analyticsRetentionDays * 24 * 60 * 60 * 1000;
    const cutoffTime = currentTime - retentionMs;

    // Clean fee collection history
    this.state.feeCollectionHistory = this.state.feeCollectionHistory.filter(
      (event) => event.timestamp > cutoffTime
    );

    // Clean reinvestment history
    this.state.reinvestmentHistory = this.state.reinvestmentHistory.filter(
      (event) => event.timestamp > cutoffTime
    );

    // Clean profitability history
    for (const [positionId, history] of this.state
      .positionProfitabilityHistory) {
      const filteredHistory = history.filter(
        (entry) => (entry as any).timestamp > cutoffTime
      );
      if (filteredHistory.length === 0) {
        this.state.positionProfitabilityHistory.delete(positionId);
      } else {
        this.state.positionProfitabilityHistory.set(
          positionId,
          filteredHistory
        );
      }
    }
  }

  /**
   * Get comprehensive analytics
   */
  getAnalytics(): FeeCollectionAnalytics {
    const positions = this.getAllPositionProfitability(Date.now());

    const totalFeesCollected0 = this.state.feeCollectionHistory.reduce(
      (sum, event) => sum + event.totalFees0,
      0n
    );

    const totalFeesCollected1 = this.state.feeCollectionHistory.reduce(
      (sum, event) => sum + event.totalFees1,
      0n
    );

    const averageProfitabilityScore =
      positions.length > 0
        ? positions.reduce((sum, pos) => sum + pos.profitabilityScore, 0) /
          positions.length
        : 0;

    const bestPerformingPosition = positions.reduce(
      (best, current) =>
        !best || current.profitabilityScore > best.profitabilityScore
          ? current
          : best,
      null as PositionProfitability | null
    );

    const worstPerformingPosition = positions.reduce(
      (worst, current) =>
        !worst || current.profitabilityScore < worst.profitabilityScore
          ? current
          : worst,
      null as PositionProfitability | null
    );

    const currentPrice = this.priceProvider.getCurrentPrice();
    const totalReinvestedValue = this.state.reinvestmentHistory.reduce(
      (sum, event) =>
        sum + Number(event.amount1) + Number(event.amount0) * currentPrice,
      0
    );

    return {
      totalFeesCollected0,
      totalFeesCollected1,
      totalReinvestmentEvents: this.state.reinvestmentHistory.length,
      averageProfitabilityScore,
      bestPerformingPosition,
      worstPerformingPosition,
      totalReinvestedValue,
      feeCollectionEfficiency: 0.95, // Would need actual calculation
      reinvestmentEfficiency: 1.05, // Would need actual ROI calculation
    };
  }

  /**
   * Get fee collection history
   */
  getFeeCollectionHistory(): FeeCollectionEvent[] {
    return [...this.state.feeCollectionHistory];
  }

  /**
   * Get reinvestment history
   */
  getReinvestmentHistory(): ReinvestmentEvent[] {
    return [...this.state.reinvestmentHistory];
  }

  /**
   * Get current configuration
   */
  getConfig(): Required<FeeCollectionConfig> {
    return { ...this.config };
  }

  /**
   * Force fee collection (manual trigger)
   */
  forceCollectFees(currentTime: number = Date.now()): FeeCollectionAction {
    const result = this.collectAllFees(currentTime);
    if (result.action === "collect_fees") {
      // Update trigger reason
      const lastEvent =
        this.state.feeCollectionHistory[
          this.state.feeCollectionHistory.length - 1
        ];
      if (lastEvent) {
        lastEvent.triggerReason = "manual";
      }
    }
    return result;
  }

  /**
   * Force reinvestment (manual trigger)
   */
  forceReinvestment(currentTime: number = Date.now()): FeeCollectionAction {
    return this.reinvestCollectedFees(currentTime);
  }
}
