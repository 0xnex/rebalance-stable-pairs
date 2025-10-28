import { Pool } from "../pool";
import { VirtualPositionManager } from "../virtual_position_mgr";

export interface ThreeBandRebalancerConfigOptionThree {
  segmentCount: number;
  segmentRangePercent: number;
  maxSwapSlippageBps: number;
  bootstrapMaxSwapSlippageBps: number;
  bootstrapAttempts: number;
  actionCostTokenA: number;
  actionCostTokenB: number;
  fastSegmentCount: number;
  fastIntervalMs: number;
  slowIntervalMs: number;
  minSegmentDwellMs: number;
  minOutOfRangeMs: number;
  rotationTickThreshold: number;
  minRotationProfitTokenB: number;
  // Enhanced features
  enableDynamicAllocation?: boolean;
  enableAdaptiveBandWidth?: boolean;
  enablePredictiveRotation?: boolean;
  enableFeeCompounding?: boolean;
  enableSmartSlippage?: boolean;
  feeCompoundingThresholdPercent?: number;
  volatilityWindowMs?: number;
  momentumWindowSize?: number;
  activeBandWeightPercent?: number;
  autoCollectIntervalMs?: number;
}

type SegmentState = {
  id: string;
  tickLower: number;
  tickUpper: number;
  lastMoved: number;
  lastFeesCollected0?: bigint;
  lastFeesCollected1?: bigint;
  lastFeeCheckTime?: number;
};

type ThreeBandAction =
  | { action: "none" | "wait"; message: string }
  | {
      action: "create" | "rebalance";
      message: string;
      segments: SegmentState[];
    };

export class ThreeBandRebalancerStrategyOptionThree {
  private readonly manager: VirtualPositionManager;
  private readonly pool: Pool;
  private config: ThreeBandRebalancerConfigOptionThree;

  private segments: SegmentState[] = [];
  private segmentWidth: number | null = null;
  private lastFastCheck = 0;
  private lastSlowCheck = 0;
  private overrideNow: number | null = null;
  private outOfRangeSinceAbove: number | null = null;
  private outOfRangeSinceBelow: number | null = null;
  private lastRotationFeesTokenA = 0n;
  private lastRotationFeesTokenB = 0n;

  // Enhanced tracking
  private volatilityWindow: Array<{ tick: number; timestamp: number }> = [];
  private tickHistory: number[] = [];
  private lastCompoundingCheck = 0;
  private lastRepairAttempt = 0; // throttle repairs to avoid spamming opens

  // Remove surplus segments, keeping exactly 3 closest to current tick
  private trimToThreeSegments(now: number, currentTick: number) {
    if (this.segments.length <= 3) return false;
    const keep = this.segments
      .slice()
      .sort((a, b) => {
        const amid = this.segmentMid(a);
        const bmid = this.segmentMid(b);
        return Math.abs(currentTick - amid) - Math.abs(currentTick - bmid);
      })
      .slice(0, 3)
      .map((s) => s.id);

    let changed = false;
    const toRemove = this.segments.filter((s) => !keep.includes(s.id));
    for (const seg of toRemove) {
      try {
        this.manager.closePosition(seg.id);
        changed = true;
      } catch {
        // ignore failures
      }
    }
    if (changed) {
      this.segments = this.segments.filter((s) => keep.includes(s.id));
      for (const s of this.segments) this.updateSegmentFeeTracking(s.id);
    }
    return changed;
  }

  constructor(
    manager: VirtualPositionManager,
    pool: Pool,
    config: Partial<ThreeBandRebalancerConfigOptionThree> & {
      checkIntervalMs?: number;
    } = {}
  ) {
    this.manager = manager;
    this.pool = pool;

    const fallbackSlow = config.checkIntervalMs ?? 60_000;
    const desiredSegmentCount = config.segmentCount ?? 5;
    const desiredFastCount = config.fastSegmentCount ?? 2;

    this.config = {
      segmentCount: Math.max(1, desiredSegmentCount),
      segmentRangePercent: config.segmentRangePercent ?? 0.001,
      maxSwapSlippageBps: config.maxSwapSlippageBps ?? 50,
      bootstrapMaxSwapSlippageBps: config.bootstrapMaxSwapSlippageBps ?? 200,
      bootstrapAttempts: config.bootstrapAttempts ?? 3,
      actionCostTokenA: config.actionCostTokenA ?? 0,
      actionCostTokenB: config.actionCostTokenB ?? 0,
      fastSegmentCount: Math.max(
        1,
        Math.min(desiredFastCount, Math.max(1, desiredSegmentCount))
      ),
      fastIntervalMs: config.fastIntervalMs ?? Math.min(30_000, fallbackSlow),
      slowIntervalMs: config.slowIntervalMs ?? Math.max(fallbackSlow, 120_000),
      minSegmentDwellMs: config.minSegmentDwellMs ?? 120_000,
      minOutOfRangeMs: config.minOutOfRangeMs ?? 120_000,
      rotationTickThreshold: config.rotationTickThreshold ?? 0,
      minRotationProfitTokenB: config.minRotationProfitTokenB ?? 0.05,
      // Enhanced features (enabled by default)
      enableDynamicAllocation: config.enableDynamicAllocation ?? true,
      enableAdaptiveBandWidth: config.enableAdaptiveBandWidth ?? true,
      enablePredictiveRotation: config.enablePredictiveRotation ?? true,
      enableFeeCompounding: config.enableFeeCompounding ?? true,
      enableSmartSlippage: config.enableSmartSlippage ?? true,
      feeCompoundingThresholdPercent:
        config.feeCompoundingThresholdPercent ?? 1.0,
      volatilityWindowMs: config.volatilityWindowMs ?? 600_000, // 10 minutes
      momentumWindowSize: config.momentumWindowSize ?? 5,
      activeBandWeightPercent: config.activeBandWeightPercent ?? 60,
    };
  }

  initialize(): ThreeBandAction {
    const result = this.reseedSegments();
    const now = this.now();
    this.lastFastCheck = now;
    this.lastSlowCheck = now;
    this.captureFeeBaseline();
    return result;
  }

  execute(): ThreeBandAction {
    if (this.segments.length === 0) {
      const result = this.reseedSegments();
      const now = this.now();
      this.lastFastCheck = now;
      this.lastSlowCheck = now;
      this.captureFeeBaseline();
      return result;
    }

    const now = this.now();
    const currentTick = this.pool.tickCurrent;

    // Hard guarantee: always maintain 3 bands. If fewer, try to repair first.
    if (this.segments.length < 3) {
      const cooldownMs = 300_000; // 5 minutes
      const sinceLast = now - this.lastRepairAttempt;
      if (sinceLast >= cooldownMs) {
        this.lastRepairAttempt = now;
        const repaired = this.ensureThreeBands(now, currentTick);
        if (repaired) {
          this.captureFeeBaseline();
          return {
            action: "rebalance",
            message: `Restored missing bands to maintain 3 positions`,
            segments: this.getSegments(),
          };
        }
      }
      const remaining = Math.max(0, this.lastRepairAttempt + 300_000 - now);
      return {
        action: "wait",
        message: `Repair cooldown ${Math.ceil(
          remaining / 1000
        )}s before retry to open missing bands`,
      };
    }

    // If we somehow have more than 3, trim to 3 closest to price
    if (this.segments.length > 3) {
      const trimmed = this.trimToThreeSegments(now, currentTick);
      if (trimmed) {
        this.captureFeeBaseline();
        return {
          action: "rebalance",
          message: `Trimmed surplus bands to maintain exactly 3 positions`,
          segments: this.getSegments(),
        };
      }
    }

    // Update tracking data
    this.updateVolatilityTracking(currentTick, now);
    this.updateTickHistory(currentTick);

    // Check for fee compounding opportunity
    if (this.config.enableFeeCompounding && this.shouldCompoundFees(now)) {
      this.compoundFees();
    }

    const fastDue = now - this.lastFastCheck >= this.config.fastIntervalMs;
    const slowDue = now - this.lastSlowCheck >= this.config.slowIntervalMs;

    if (!fastDue && !slowDue) {
      const fastRemaining =
        this.config.fastIntervalMs - (now - this.lastFastCheck);
      const slowRemaining =
        this.config.slowIntervalMs - (now - this.lastSlowCheck);
      const remaining = Math.max(0, Math.min(fastRemaining, slowRemaining));
      return {
        action: "wait",
        message: `Waiting ${Math.ceil(remaining / 1000)}s for next check`,
      };
    }
    const fastIndices = this.getFastSegmentIndices(currentTick);

    const lastSegment = this.segments[this.segments.length - 1];
    const firstSegment = this.segments[0];
    if (!lastSegment || !firstSegment) {
      return { action: "none", message: "Invalid segment state" };
    }

    const priceAbove = currentTick >= lastSegment.tickUpper;
    const priceBelow = currentTick < firstSegment.tickLower;

    if (priceAbove) {
      this.outOfRangeSinceAbove = this.outOfRangeSinceAbove ?? now;
    } else {
      this.outOfRangeSinceAbove = null;
    }

    if (priceBelow) {
      this.outOfRangeSinceBelow = this.outOfRangeSinceBelow ?? now;
    } else {
      this.outOfRangeSinceBelow = null;
    }

    if (!priceAbove && !priceBelow) {
      // Case 3: Position 1 (middle) still in-range -> No rebalance.
      // Case 1: Only middle band out-of-range -> Rebalance middle band only.

      // When we have at least 3 bands, treat the middle index as Position 1
      if (this.segments.length >= 3 && this.segmentWidth !== null) {
        const midIndex = Math.floor(this.segments.length / 2);
        const middle = this.segments[midIndex];
        if (middle) {
          const middleInRange =
            currentTick >= middle.tickLower && currentTick < middle.tickUpper;
          if (!middleInRange) {
            // Dwell guard for the middle band
            if (now - middle.lastMoved < this.config.minSegmentDwellMs) {
              const remaining =
                this.config.minSegmentDwellMs - (now - middle.lastMoved);
              return {
                action: "wait",
                message: `Middle band dwell guard active, ${Math.ceil(
                  Math.max(0, remaining) / 1000
                )}s remaining before middle rebalance`,
              };
            }

            // Rebalance only the middle band to cover current tick.
            // Also ensure the new range overlaps both neighbors so middle is always the band covering price.
            // Compute contiguous layout around current tick using fixed segmentWidth.
            const newMiddleLower =
              currentTick - Math.floor(this.segmentWidth / 2);
            const newMiddleUpper = newMiddleLower + this.segmentWidth;
            const newLowerBand = {
              lower: newMiddleLower - this.segmentWidth,
              upper: newMiddleLower,
            };
            const newUpperBand = {
              lower: newMiddleUpper,
              upper: newMiddleUpper + this.segmentWidth,
            };

            try {
              // remove and reopen the middle position
              this.manager.closePosition(middle.id);
              const replacement = this.openSegment(
                newMiddleLower,
                newMiddleUpper,
                now
              );
              // Replace middle segment in-place to preserve ordering
              this.segments[midIndex] = replacement;

              // Case 1 requirement: do not touch positions 2 and 3

              // Update fee tracking for all segments after rebalance
              for (const segment of this.segments) {
                this.updateSegmentFeeTracking(segment.id);
              }

              this.captureFeeBaseline();
              return {
                action: "rebalance",
                message: `Rebalanced middle band to cover tick ${currentTick}`,
                segments: this.getSegments(),
              };
            } catch (err) {
              return {
                action: "none",
                message: `Failed to rebalance middle band: ${
                  (err as Error).message
                }`,
              };
            }
          } else {
            // Middle in range: ensure we still have 3 contiguous bands.
            // If some bands were missing due to previous failures, try to restore them
            const repaired = this.ensureThreeBands(now, currentTick);
            if (repaired) {
              this.captureFeeBaseline();
              return {
                action: "rebalance",
                message: `Restored missing bands around middle to maintain 3 positions`,
                segments: this.getSegments(),
              };
            }
          }
        }
      }

      // Check for predictive rotation
      if (this.config.enablePredictiveRotation) {
        const predictiveDirection = this.shouldPreemptivelyRotate(currentTick);
        if (predictiveDirection) {
          return this.handleRotation(
            predictiveDirection,
            now,
            fastDue,
            slowDue,
            fastIndices,
            currentTick
          );
        }
      }

      if (fastDue) this.lastFastCheck = now;
      if (slowDue) this.lastSlowCheck = now;
      return {
        action: "none",
        message: `Bands still covering price at tick ${currentTick}`,
      };
    }

    if (priceAbove) {
      return this.handleRotation(
        "up",
        now,
        fastDue,
        slowDue,
        fastIndices,
        currentTick
      );
    }

    if (priceBelow) {
      return this.handleRotation(
        "down",
        now,
        fastDue,
        slowDue,
        fastIndices,
        currentTick
      );
    }

    if (fastDue) this.lastFastCheck = now;
    if (slowDue) this.lastSlowCheck = now;

    return {
      action: "none",
      message: `No rotation required for tick ${currentTick}`,
    };
  }

  setCurrentTime(timestamp: number | null) {
    this.overrideNow = timestamp;
  }

  getSegments(): SegmentState[] {
    return this.segments.map((segment) => ({ ...segment }));
  }

  private reseedSegments(): ThreeBandAction {
    this.clearSegments();

    const currentPrice = this.pool.price;
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
      return {
        action: "none",
        message: "Invalid pool price; cannot seed segments",
      };
    }

    const rangePercent = this.config.enableAdaptiveBandWidth
      ? this.calculateAdaptiveBandWidth()
      : this.config.segmentRangePercent;

    const { lowerTick, upperTick } = this.computeRangeTicks(rangePercent);

    const width = upperTick - lowerTick;
    if (width <= 0) {
      return {
        action: "none",
        message: "Computed zero-width segment; aborting",
      };
    }

    const segmentCount = this.config.segmentCount;
    const startLower = lowerTick - width * Math.floor(segmentCount / 2);

    const descriptors: Array<{ lower: number; upper: number; mid: number }> =
      [];
    let currentLower = startLower;
    for (let i = 0; i < segmentCount; i++) {
      const currentUpper = currentLower + width;
      const mid = Math.floor((currentLower + currentUpper) / 2);
      descriptors.push({ lower: currentLower, upper: currentUpper, mid });
      currentLower = currentUpper;
    }

    const currentTick = this.pool.tickCurrent;
    const openOrder = descriptors.slice().sort((a, b) => {
      const aContains = currentTick >= a.lower && currentTick < a.upper ? 0 : 1;
      const bContains = currentTick >= b.lower && currentTick < b.upper ? 0 : 1;
      if (aContains !== bContains) {
        return aContains - bContains;
      }
      return Math.abs(currentTick - a.mid) - Math.abs(currentTick - b.mid);
    });

    const now = this.now();
    const opened: SegmentState[] = [];

    // Calculate weights for dynamic allocation
    const weights = this.calculateSegmentWeights(descriptors, currentTick);

    // Capture initial capital before opening any positions
    const initialTotals = this.manager.getTotals();
    const initialCapitalA = initialTotals.cashAmountA ?? initialTotals.amountA;
    const initialCapitalB = initialTotals.cashAmountB ?? initialTotals.amountB;

    for (let i = 0; i < openOrder.length; i++) {
      const descriptor = openOrder[i];
      if (!descriptor) continue;

      const originalIndex = descriptors.findIndex(
        (d) => d.lower === descriptor.lower && d.upper === descriptor.upper
      );
      const weight =
        originalIndex >= 0 ? weights[originalIndex] : 1.0 / descriptors.length;

      try {
        const segment = this.openSegment(
          descriptor.lower,
          descriptor.upper,
          now,
          weight,
          initialCapitalA,
          initialCapitalB
        );
        opened.push(segment);
      } catch (error) {
        // Log but continue - allows partial deployment if some positions fail
        console.warn(
          `[three-band] Failed to open position [${descriptor.lower},${
            descriptor.upper
          }]: ${error instanceof Error ? error.message : String(error)}`
        );
        // Continue trying to open other positions
      }
    }

    this.segments = opened.sort((a, b) => a.tickLower - b.tickLower);
    this.segmentWidth = width;

    // Try to ensure we end with 3 bands even if some opens failed
    if (opened.length < segmentCount) {
      // Apply the same 5-minute cooldown between repair attempts during seed
      const cooldownMs = 300_000; // 5 minutes
      const sinceLast = now - this.lastRepairAttempt;
      if (sinceLast >= cooldownMs) {
        this.lastRepairAttempt = now;
        const repaired = this.ensureThreeBands(now, this.pool.tickCurrent);
        if (repaired) {
          this.segments.sort((a, b) => a.tickLower - b.tickLower);
        }
      }
    }

    // Check if we opened at least one position
    if (this.segments.length === 0) {
      return {
        action: "none",
        message: `Failed to open any positions - slippage too high or insufficient capital`,
      };
    }

    // Ensure we never exceed 3 after seed/repair
    if (this.segments.length > 3) {
      this.trimToThreeSegments(now, this.pool.tickCurrent);
    }

    const successMessage =
      this.segments.length < segmentCount
        ? `Seeded ${this.segments.length}/${segmentCount} bands (will keep repairing to reach 3)`
        : `Seeded ${segmentCount} contiguous bands around price ${currentPrice.toFixed(
            6
          )} (width: ${rangePercent.toFixed(4)}%)`;

    return {
      action: "create",
      message: successMessage,
      segments: this.getSegments(),
    };
  }

  private rotateUp(timestamp: number, targetTick?: number): boolean {
    if (this.segments.length === 0 || this.segmentWidth === null) {
      return false;
    }

    const removed = this.segments.shift();
    if (!removed) return false;

    try {
      this.manager.closePosition(removed.id);
    } catch (err) {
      this.segments.unshift(removed);
      return false;
    }

    const lastSegment = this.segments[this.segments.length - 1];
    let newLower: number;
    let newUpper: number;

    if (targetTick !== undefined && lastSegment) {
      // Smart placement: ensure new band covers the target tick
      const currentTick = targetTick;

      // If price is way above our bands, place new band to cover it
      if (currentTick >= lastSegment.tickUpper) {
        // Center the new band around current tick
        newLower = currentTick - Math.floor(this.segmentWidth / 2);
        newUpper = newLower + this.segmentWidth;
      } else {
        // Normal contiguous placement
        newLower = lastSegment.tickUpper;
        newUpper = newLower + this.segmentWidth;
      }
    } else {
      // Fallback: contiguous placement
      const baseLower =
        this.segments.length > 0 && lastSegment
          ? lastSegment.tickUpper
          : removed.tickUpper;
      newLower = baseLower;
      newUpper = newLower + this.segmentWidth;
    }

    try {
      const replacement = this.openSegment(newLower, newUpper, timestamp);
      this.segments.push(replacement);

      // Update fee tracking for all segments after rotation
      for (const segment of this.segments) {
        this.updateSegmentFeeTracking(segment.id);
      }

      return true;
    } catch (error) {
      try {
        const restored = this.openSegment(
          removed.tickLower,
          removed.tickUpper,
          removed.lastMoved
        );
        this.segments.push(restored);
      } catch (restoreErr) {
        // ignore restoration failure
      }
      return false;
    }
  }

  private rotateDown(timestamp: number, targetTick?: number): boolean {
    if (this.segments.length === 0 || this.segmentWidth === null) {
      return false;
    }

    const removed = this.segments.pop();
    if (!removed) return false;

    try {
      this.manager.closePosition(removed.id);
    } catch (err) {
      this.segments.push(removed);
      return false;
    }

    const firstSegment = this.segments[0];
    let newLower: number;
    let newUpper: number;

    if (targetTick !== undefined && firstSegment) {
      // Smart placement: ensure new band covers the target tick
      const currentTick = targetTick;

      // If price is way below our bands, place new band to cover it
      if (currentTick < firstSegment.tickLower) {
        // Center the new band around current tick
        newLower = currentTick - Math.floor(this.segmentWidth / 2);
        newUpper = newLower + this.segmentWidth;
      } else {
        // Normal contiguous placement
        newUpper = firstSegment.tickLower;
        newLower = newUpper - this.segmentWidth;
      }
    } else {
      // Fallback: contiguous placement
      const baseUpper =
        this.segments.length > 0 && firstSegment
          ? firstSegment.tickLower
          : removed.tickLower;
      newUpper = baseUpper;
      newLower = newUpper - this.segmentWidth;
    }

    try {
      const replacement = this.openSegment(newLower, newUpper, timestamp);
      this.segments.unshift(replacement);

      // Update fee tracking for all segments after rotation
      for (const segment of this.segments) {
        this.updateSegmentFeeTracking(segment.id);
      }

      return true;
    } catch (error) {
      try {
        const restored = this.openSegment(
          removed.tickLower,
          removed.tickUpper,
          removed.lastMoved
        );
        this.segments.unshift(restored);
      } catch (restoreErr) {
        // ignore
      }
      return false;
    }
  }

  private clearSegments() {
    for (const segment of this.segments) {
      try {
        this.manager.closePosition(segment.id);
      } catch (err) {
        // ignore cleanup failures
      }
    }
    this.segments = [];
  }

  private openSegment(
    tickLower: number,
    tickUpper: number,
    timestamp: number,
    weight?: number,
    initialCapitalA?: bigint,
    initialCapitalB?: bigint
  ): SegmentState {
    const slippages = this.buildSlippageAttempts();
    const totals = this.manager.getTotals();
    const baseAvailableA = totals.cashAmountA ?? totals.amountA;
    const baseAvailableB = totals.cashAmountB ?? totals.amountB;

    // Apply desired weight (equal allocation across segments) against initial capital if provided
    const weightedA = (() => {
      const baseA = initialCapitalA ?? baseAvailableA;
      if (weight === undefined) return baseAvailableA;
      return (baseA * BigInt(Math.floor(weight * 10000))) / 10000n;
    })();
    const weightedB = (() => {
      const baseB = initialCapitalB ?? baseAvailableB;
      if (weight === undefined) return baseAvailableB;
      return (baseB * BigInt(Math.floor(weight * 10000))) / 10000n;
    })();

    // Size backoff factors to increase success probability under tight bands/slippage
    const sizeBackoff: number[] = [1.0, 0.5, 0.25];

    let lastError: Error | null = null;

    for (const scale of sizeBackoff) {
      const scaledA = (weightedA * BigInt(Math.floor(scale * 100))) / 100n;
      const scaledB = (weightedB * BigInt(Math.floor(scale * 100))) / 100n;

      this.manager.openPosition(tickLower, tickUpper, scaledA, scaledB);

      for (const slippage of slippages) {
        try {
          const preSwapTick = this.pool.tickCurrent;
          const preSwapPrice = this.pool.price;

          const result = this.manager.addLiquidityWithSwap(
            tickLower,
            tickUpper,
            scaledA,
            scaledB,
            slippage,
            this.getActionCost()
          );

          const postSwapTick = this.pool.tickCurrent;
          const postSwapPrice = this.pool.price;
          const inRange = postSwapTick >= tickLower && postSwapTick < tickUpper;

          // Validate the created position actually has liquidity; otherwise, clean up and retry
          const created = this.manager.getPosition(result.positionId);
          if (!created || created.liquidity === 0n) {
            try {
              this.manager.removePosition(
                result.positionId,
                this.getActionCost()
              );
            } catch {
              // ignore cleanup failures
            }
            lastError = new Error(
              `Zero-liquidity open for [${tickLower}, ${tickUpper}] at slippage=${slippage} scale=${scale}`
            );
            console.warn(
              `[three-band] Zero-liquidity open; retrying with backoff. slippage=${slippage} scale=${scale}`
            );
            continue;
          }

          // Log price movement from swap
          if (postSwapTick !== preSwapTick) {
            console.log(`[ThreeBand-PriceImpact] Swap moved price:`);
            console.log(
              `  Before: tick=${preSwapTick}, price=${preSwapPrice.toFixed(6)}`
            );
            console.log(
              `  After:  tick=${postSwapTick}, price=${postSwapPrice.toFixed(
                6
              )}`
            );
            console.log(`  Delta:  ${postSwapTick - preSwapTick} ticks`);
            console.log(`  Position range: [${tickLower}, ${tickUpper}]`);
            console.log(`  In range: ${inRange ? "✓ YES" : "✗ NO"}`);
          }

          return {
            id: result.positionId,
            tickLower,
            tickUpper,
            lastMoved: timestamp,
            lastFeesCollected0: 0n,
            lastFeesCollected1: 0n,
            lastFeeCheckTime: timestamp,
          };
        } catch (err) {
          lastError = err as Error;
          console.warn(
            `[three-band] Failed to open [${tickLower}, ${tickUpper}] slippage=${slippage} scale=${scale}: ${lastError.message}`
          );
        }
      }
    }

    throw new Error(
      `Failed to open segment [${tickLower}, ${tickUpper}]: ${
        lastError?.message ?? "unknown error"
      }`
    );
  }

  private buildSlippageAttempts(): number[] {
    const attempts = new Set<number>();

    // Use smart slippage if enabled
    const optimalSlippage = this.config.enableSmartSlippage
      ? this.calculateOptimalSlippage()
      : this.config.maxSwapSlippageBps;

    attempts.add(Math.max(1, optimalSlippage));
    attempts.add(Math.max(1, this.config.maxSwapSlippageBps));
    attempts.add(Math.max(1, this.config.bootstrapMaxSwapSlippageBps));

    let current = Math.max(1, this.config.bootstrapMaxSwapSlippageBps);
    for (let i = 1; i < this.config.bootstrapAttempts; i++) {
      current = Math.min(10_000, current * 2);
      attempts.add(current);
    }

    return Array.from(attempts).sort((a, b) => a - b);
  }

  private getFastSegmentIndices(currentTick: number): Set<number> {
    const fastCount = Math.min(
      this.config.fastSegmentCount,
      this.segments.length
    );
    if (fastCount <= 0) {
      return new Set();
    }

    const ranked = this.segments
      .map((segment, index) => ({
        index,
        distance: Math.abs(currentTick - this.segmentMid(segment)),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, fastCount)
      .map((entry) => entry.index);

    return new Set(ranked);
  }

  private segmentMid(segment: SegmentState): number {
    return Math.floor((segment.tickLower + segment.tickUpper) / 2);
  }

  private canRotate(
    direction: "up" | "down",
    now: number,
    currentTick: number
  ): boolean {
    const thresholdTicks = this.config.rotationTickThreshold;
    if (thresholdTicks > 0) {
      const lastSegment = this.segments[this.segments.length - 1];
      const firstSegment = this.segments[0];
      if (!lastSegment || !firstSegment) return false;

      const boundaryTick =
        direction === "up" ? lastSegment.tickUpper : firstSegment.tickLower;
      const distance = Math.abs(currentTick - boundaryTick);
      if (distance < thresholdTicks) {
        return false;
      }
    }

    const outSince =
      direction === "up"
        ? this.outOfRangeSinceAbove
        : this.outOfRangeSinceBelow;
    if (outSince !== null && now - outSince < this.config.minOutOfRangeMs) {
      return false;
    }

    // Fee velocity check removed for simplicity

    if (this.config.minRotationProfitTokenB <= 0) {
      return true;
    }

    // Collect fees from all positions to get accurate fee totals
    for (const segment of this.segments) {
      this.manager.collectFees(segment.id);
    }

    const totals = this.manager.getTotals();
    // Use raw values (no decimal normalization)
    const deltaA = Number(totals.collectedFees0 - this.lastRotationFeesTokenA);
    const deltaB = Number(totals.collectedFees1 - this.lastRotationFeesTokenB);
    const estimatedB = deltaB + deltaA * this.pool.price;
    const rotationCost = (this.config.actionCostTokenB ?? 0) * 2;
    return estimatedB - rotationCost >= this.config.minRotationProfitTokenB;
  }

  private captureFeeBaseline() {
    const totals = this.manager.getTotals();
    this.lastRotationFeesTokenA = totals.collectedFees0;
    this.lastRotationFeesTokenB = totals.collectedFees1;
  }

  private handleRotation(
    direction: "up" | "down",
    now: number,
    fastDue: boolean,
    slowDue: boolean,
    fastIndices: Set<number>,
    currentTick: number
  ): ThreeBandAction {
    if (this.segments.length === 0) {
      return {
        action: "none",
        message: "No segments available for rotation",
      };
    }

    const candidateIndex = direction === "up" ? 0 : this.segments.length - 1;
    const candidate = this.segments[candidateIndex];
    if (!candidate) {
      return {
        action: "none",
        message: "No candidate segment found for rotation",
      };
    }

    const isFast = fastIndices.has(candidateIndex);
    const due = isFast ? fastDue : slowDue;

    if (!due) {
      const remaining = isFast
        ? this.config.fastIntervalMs - (now - this.lastFastCheck)
        : this.config.slowIntervalMs - (now - this.lastSlowCheck);
      return {
        action: "wait",
        message: `Waiting ${Math.ceil(
          Math.max(0, remaining) / 1000
        )}s before rotating ${direction} segment`,
      };
    }

    if (now - candidate.lastMoved < this.config.minSegmentDwellMs) {
      const remaining =
        this.config.minSegmentDwellMs - (now - candidate.lastMoved);
      return {
        action: "wait",
        message: `Segment dwell guard active, ${Math.ceil(
          Math.max(0, remaining) / 1000
        )}s remaining before ${direction} rotation`,
      };
    }

    if (!this.canRotate(direction, now, currentTick)) {
      if (isFast) this.lastFastCheck = now;
      if (!isFast || slowDue) this.lastSlowCheck = now;
      return {
        action: "wait",
        message: `Cost guard preventing ${direction} rotation at tick ${currentTick}`,
      };
    }

    // Rotate multiple times if needed to catch up with price
    let rotationCount = 0;
    const maxRotations = this.segments.length * 2; // Safety limit

    while (rotationCount < maxRotations) {
      const firstSeg = this.segments[0];
      const lastSeg = this.segments[this.segments.length - 1];

      if (!firstSeg || !lastSeg) break;

      // Check if we're now in range
      const priceAbove = currentTick >= lastSeg.tickUpper;
      const priceBelow = currentTick < firstSeg.tickLower;

      if (!priceAbove && !priceBelow) {
        // We've caught up - at least one band covers the price
        break;
      }

      // Continue rotating in the same direction, passing target tick for smart placement
      const rotated =
        direction === "up"
          ? this.rotateUp(now, currentTick)
          : this.rotateDown(now, currentTick);

      if (!rotated) {
        // If rotation fails, stop trying
        break;
      }

      rotationCount++;
    }

    if (rotationCount === 0) {
      if (isFast) this.lastFastCheck = now;
      if (!isFast || slowDue) this.lastSlowCheck = now;
      return {
        action: "none",
        message: `Rotation ${direction} failed for tick ${currentTick}`,
      };
    }

    if (isFast) this.lastFastCheck = now;
    if (!isFast || slowDue) this.lastSlowCheck = now;

    if (direction === "up") {
      this.outOfRangeSinceAbove = null;
    } else {
      this.outOfRangeSinceBelow = null;
    }

    this.captureFeeBaseline();

    const rotationMsg =
      rotationCount === 1
        ? `Rotated ${direction} 1 band to cover tick ${currentTick}`
        : `Rotated ${direction} ${rotationCount} bands to catch up with tick ${currentTick}`;

    return {
      action: "rebalance",
      message: rotationMsg,
      segments: this.getSegments(),
    };
  }

  private computeRangeTicks(rangePercent: number): {
    lowerTick: number;
    upperTick: number;
  } {
    const currentPrice = this.pool.price;
    const halfPercent = rangePercent / 100;
    const lowerPrice = Math.max(1e-12, currentPrice * (1 - halfPercent));
    const upperPrice = Math.max(
      lowerPrice * 1.0001,
      currentPrice * (1 + halfPercent)
    );

    let lowerTick = this.priceToTick(lowerPrice);
    let upperTick = this.priceToTick(upperPrice);

    const spacing = Math.max(1, this.pool.tickSpacing || 1);
    lowerTick = Math.floor(lowerTick / spacing) * spacing;
    upperTick = Math.ceil(upperTick / spacing) * spacing;

    if (upperTick <= lowerTick) {
      upperTick = lowerTick + spacing;
    }

    return { lowerTick, upperTick };
  }

  private priceToTick(price: number): number {
    return Math.floor(Math.log(price) / Math.log(1.0001));
  }

  private getActionCost(): { tokenA?: number; tokenB?: number } | undefined {
    const costA = this.config.actionCostTokenA;
    const costB = this.config.actionCostTokenB;
    const hasA = costA > 0;
    const hasB = costB > 0;
    if (!hasA && !hasB) return undefined;

    const cost: { tokenA?: number; tokenB?: number } = {};
    if (hasA) cost.tokenA = costA;
    if (hasB) cost.tokenB = costB;
    return cost;
  }

  private now(): number {
    return this.overrideNow ?? Date.now();
  }

  // ============================================================================
  // Enhanced Features - Helper Methods
  // ============================================================================

  /**
   * Update volatility tracking window with current tick
   */
  private updateVolatilityTracking(currentTick: number, timestamp: number) {
    if (!this.config.enableAdaptiveBandWidth) return;

    const windowMs = this.config.volatilityWindowMs ?? 600_000;

    // Add current tick
    this.volatilityWindow.push({ tick: currentTick, timestamp });

    // Remove old entries outside window
    this.volatilityWindow = this.volatilityWindow.filter(
      (entry) => timestamp - entry.timestamp < windowMs
    );
  }

  /**
   * Update tick history for momentum tracking
   */
  private updateTickHistory(currentTick: number) {
    if (!this.config.enablePredictiveRotation) return;

    const maxSize = this.config.momentumWindowSize ?? 5;

    // Only add if tick has changed
    const lastTick = this.tickHistory[this.tickHistory.length - 1];
    if (this.tickHistory.length === 0 || lastTick !== currentTick) {
      this.tickHistory.push(currentTick);
    }

    // Keep only recent history
    if (this.tickHistory.length > maxSize) {
      this.tickHistory = this.tickHistory.slice(-maxSize);
    }
  }

  /**
   * Calculate adaptive band width based on recent volatility
   */
  private calculateAdaptiveBandWidth(): number {
    const baseWidth = this.config.segmentRangePercent;

    if (this.volatilityWindow.length < 2) {
      return baseWidth;
    }

    // Calculate tick changes between consecutive entries
    const tickChanges: number[] = [];
    for (let i = 1; i < this.volatilityWindow.length; i++) {
      const current = this.volatilityWindow[i];
      const previous = this.volatilityWindow[i - 1];
      if (current && previous) {
        const change = Math.abs(current.tick - previous.tick);
        tickChanges.push(change);
      }
    }

    if (tickChanges.length === 0) {
      return baseWidth;
    }

    // Calculate average tick volatility
    const avgTickChange =
      tickChanges.reduce((a, b) => a + b, 0) / tickChanges.length;

    // Scale width based on volatility
    // Low volatility (< 5 ticks) = tighter bands (0.5x-1x)
    // Medium volatility (5-20 ticks) = normal bands (1x)
    // High volatility (> 20 ticks) = wider bands (1x-2x)
    const volatilityMultiplier = Math.max(
      0.5,
      Math.min(2.0, 0.5 + avgTickChange / 20)
    );

    return baseWidth * volatilityMultiplier;
  }

  /**
   * Calculate weights for capital allocation
   * Simplified to always use equal weights
   */
  private calculateSegmentWeights(
    descriptors: Array<{ lower: number; upper: number; mid: number }>,
    currentTick: number
  ): number[] {
    // Option 3: If we have three segments, allocate 60%/25%/15%
    if (descriptors.length === 3) {
      // Find middle descriptor (whose range contains or is closest to current tick)
      const midIdx = (() => {
        const contains = descriptors.map((d) =>
          currentTick >= d.lower && currentTick < d.upper ? 1 : 0
        );
        const idx = contains.findIndex((v) => v === 1);
        if (idx !== -1) return idx;
        // Fallback: closest by mid
        let best = 0;
        const firstMid = descriptors[0]?.mid ?? currentTick;
        let bestDist = Math.abs(currentTick - firstMid);
        for (let i = 1; i < descriptors.length; i++) {
          const mid = descriptors[i]?.mid ?? currentTick;
          const dist = Math.abs(currentTick - mid);
          if (dist < bestDist) {
            best = i;
            bestDist = dist;
          }
        }
        return best;
      })();

      const weights = [0, 0, 0];
      weights[midIdx] = 0.6; // Position 1 (middle)
      // Upper is index midIdx+1, lower is midIdx-1, if present
      if (midIdx + 1 < 3) weights[midIdx + 1] = 0.2; // Position 2 (upper)
      if (midIdx - 1 >= 0) weights[midIdx - 1] = 0.2; // Position 3 (lower)
      return weights;
    }

    // Fallback: equal weights
    const equalWeight = 1.0 / descriptors.length;
    return descriptors.map(() => equalWeight);
  }

  /**
   * Check if predictive rotation should occur based on momentum
   */
  private shouldPreemptivelyRotate(currentTick: number): "up" | "down" | null {
    if (this.tickHistory.length < 3 || this.segmentWidth === null) {
      return null;
    }

    // Calculate tick velocity (average change per update)
    const recentTicks = this.tickHistory.slice(-3);
    const firstTick = recentTicks[0];
    const lastTick = recentTicks[2];
    if (firstTick === undefined || lastTick === undefined) {
      return null;
    }

    const tickVelocity = (lastTick - firstTick) / 2;

    // Need significant momentum
    if (Math.abs(tickVelocity) < 2) {
      return null;
    }

    const lastSegment = this.segments[this.segments.length - 1];
    const firstSegment = this.segments[0];
    if (!lastSegment || !firstSegment) {
      return null;
    }

    const upperBound = lastSegment.tickUpper;
    const lowerBound = firstSegment.tickLower;

    // Calculate distance to boundaries
    const ticksToUpper = upperBound - currentTick;
    const ticksToLower = currentTick - lowerBound;

    // Preemptively rotate when within 30% of boundary with momentum
    const threshold = this.segmentWidth * 0.3;

    if (tickVelocity > 0 && ticksToUpper < threshold && ticksToUpper > 0) {
      return "up";
    }

    if (tickVelocity < 0 && ticksToLower < threshold && ticksToLower > 0) {
      return "down";
    }

    return null;
  }

  /**
   * Check if fees should be compounded
   */
  private shouldCompoundFees(now: number): boolean {
    // Check every 5 minutes
    const compoundCheckInterval = 300_000;
    if (now - this.lastCompoundingCheck < compoundCheckInterval) {
      return false;
    }

    this.lastCompoundingCheck = now;

    const totals = this.manager.getTotals();
    const unclaimedFees = totals.feesOwed0 + totals.feesOwed1;
    const totalValue = totals.amountA + totals.amountB;

    if (totalValue === 0n) {
      return false;
    }

    // Compound when unclaimed fees exceed threshold
    const thresholdPct = this.config.feeCompoundingThresholdPercent ?? 1.0;
    const threshold =
      (totalValue * BigInt(Math.floor(thresholdPct * 100))) / 10000n;

    return unclaimedFees > threshold;
  }

  /**
   * Collect and compound fees back into positions
   */
  private compoundFees() {
    // Collect fees from all segments
    for (const segment of this.segments) {
      try {
        this.manager.collectAllPositionFees();
      } catch (err) {
        // Continue collecting from other positions
      }
    }

    // Note: Fees are automatically added to cash balance by collectFees
    // They will be redeployed during next rotation or rebalance
  }

  /**
   * Calculate optimal slippage based on position size and pool depth
   */
  private calculateOptimalSlippage(): number {
    if (!this.config.enableSmartSlippage) {
      return this.config.maxSwapSlippageBps;
    }

    const totals = this.manager.getTotals();
    const poolLiquidity = this.pool.liquidity;

    if (poolLiquidity === 0n) {
      return this.config.maxSwapSlippageBps;
    }

    // Calculate position size relative to pool
    // Using token amounts as a proxy for liquidity size
    const positionValue = totals.amountA + totals.amountB;
    const poolValue = poolLiquidity; // Simplified comparison

    const sizeRatio = Number(positionValue) / Number(poolValue);

    // Scale slippage based on size ratio
    // Smaller positions need less slippage
    const baseSlippage = this.config.maxSwapSlippageBps;
    const scaledSlippage = Math.max(
      10, // Minimum 0.1%
      Math.floor(baseSlippage * Math.sqrt(Math.max(0.01, sizeRatio)))
    );

    return Math.min(scaledSlippage, this.config.bootstrapMaxSwapSlippageBps);
  }

  /**
   * Enhanced rotation check with fee velocity analysis
   */
  private shouldRotateBasedOnFeeVelocity(
    direction: "up" | "down",
    now: number
  ): boolean {
    const candidateIdx = direction === "up" ? 0 : this.segments.length - 1;
    const candidate = this.segments[candidateIdx];

    if (!candidate) {
      // No candidate, don't rotate
      return false;
    }

    if (
      candidate.lastFeeCheckTime === undefined ||
      candidate.lastFeesCollected0 === undefined ||
      candidate.lastFeesCollected1 === undefined
    ) {
      // No fee history yet, allow rotation
      return true;
    }

    try {
      // Get current fees for the position
      const fees = this.manager.calculatePositionFees(candidate.id);
      const totalFees = fees.fee0 + fees.fee1;
      const lastTotalFees =
        candidate.lastFeesCollected0 + candidate.lastFeesCollected1;

      // Calculate fee generation rate
      const timeActive = Math.max(1, now - candidate.lastFeeCheckTime);
      const feeIncrease =
        totalFees > lastTotalFees ? totalFees - lastTotalFees : 0n;
      const feeRatePerMs = Number(feeIncrease) / timeActive;

      // Estimate rotation cost in terms of time
      const rotationCost = (this.config.actionCostTokenB || 0) * 2 * 1_000_000; // Convert to atomic units
      const rotationCostMs =
        feeRatePerMs > 0 ? rotationCost / feeRatePerMs : Infinity;

      // Only rotate if position has been active long enough to cover costs with 1.5x buffer
      const minActiveTime = Math.max(
        this.config.minSegmentDwellMs,
        rotationCostMs * 1.5
      );

      return timeActive >= minActiveTime;
    } catch (err) {
      // On error, fall back to allowing rotation
      return true;
    }
  }

  /**
   * Update segment fee tracking data
   */
  private updateSegmentFeeTracking(segmentId: string) {
    const segment = this.segments.find((s) => s.id === segmentId);
    if (!segment) return;

    try {
      const fees = this.manager.calculatePositionFees(segmentId);
      segment.lastFeesCollected0 = fees.fee0;
      segment.lastFeesCollected1 = fees.fee1;
      segment.lastFeeCheckTime = this.now();
    } catch (err) {
      // Ignore tracking errors
    }
  }

  // Ensure we maintain exactly three contiguous bands around current tick.
  // Returns true if any repair/open was performed.
  private ensureThreeBands(now: number, currentTick: number): boolean {
    if (this.segmentWidth === null) return false;

    // If we already have 3 bands, nothing to do
    if (this.segments.length === 3) return false;

    // If we have 0-2 bands, try to fill missing bands by opening around middle
    // Determine desired contiguous layout centered on current tick
    const middleLower = currentTick - Math.floor(this.segmentWidth / 2);
    const middleUpper = middleLower + this.segmentWidth;

    const desired: Array<{ lower: number; upper: number }> = [];
    // Lower band
    desired.push({
      lower: middleLower - this.segmentWidth,
      upper: middleLower,
    });
    // Middle band
    desired.push({ lower: middleLower, upper: middleUpper });
    // Upper band
    desired.push({
      lower: middleUpper,
      upper: middleUpper + this.segmentWidth,
    });

    // Track existing ranges for quick check
    const existing = new Set(
      this.segments.map((s) => `${s.tickLower}:${s.tickUpper}`)
    );

    let changed = false;
    for (const d of desired) {
      const key = `${d.lower}:${d.upper}`;
      if (existing.has(key)) continue;
      try {
        const seg = this.openSegment(d.lower, d.upper, now);
        this.segments.push(seg);
        changed = true;
      } catch {
        // If opening fails, continue; we'll try again later via backoff
      }
    }

    if (changed) {
      this.segments.sort((a, b) => a.tickLower - b.tickLower);
      for (const s of this.segments) this.updateSegmentFeeTracking(s.id);
    }

    return changed;
  }
}

export default ThreeBandRebalancerStrategyOptionThree;
