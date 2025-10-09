import { describe, it, expect, beforeEach } from "bun:test";
import { Pool } from "../src/pool";
import type { VirtualPositionManager } from "../src/virtual_position_mgr";
import { ThreeBandRebalancerStrategy } from "../src/strategies/three_band_rebalancer_strategy";

function createTestPool(): Pool {
  const pool = new Pool(0.0001, 60, 100n);
  pool.reserveA = 1_000_000n;
  pool.reserveB = 1_000_000n;
  pool.sqrtPriceX64 = 18446744073709551616n; // price ≈ 1.0
  pool.tickCurrent = 0;
  pool.liquidity = 1_000_000n;
  return pool;
}

describe("ThreeBandRebalancerStrategy", () => {
  let pool: Pool;
  class FakeManager {
    private counter = 0;
    private initialA = 0n;
    private initialB = 0n;
    public cashA = 0n;
    public cashB = 0n;
    public positions: SegmentRecord[] = [];

    constructor(public readonly pool: Pool) {}

    setInitialBalances(a: bigint, b: bigint) {
      this.initialA = a;
      this.initialB = b;
      this.cashA = a;
      this.cashB = b;
    }

    getTotals() {
      return {
        amountA: 0n,
        amountB: 0n,
        feesOwed0: 0n,
        feesOwed1: 0n,
        positions: this.positions.length,
        initialAmountA: this.initialA,
        initialAmountB: this.initialB,
        cashAmountA: this.cashA,
        cashAmountB: this.cashB,
        collectedFees0: 0n,
        collectedFees1: 0n,
        totalCostTokenA: 0,
        totalCostTokenB: 0,
      };
    }

    addLiquidityWithSwap(
      tickLower: number,
      tickUpper: number,
      _maxAmountA: bigint,
      _maxAmountB: bigint,
      _slippage: number,
      _actionCost?: unknown
    ) {
      const id = `segment-${++this.counter}`;
      this.positions.push({ id, tickLower, tickUpper });
      return {
        positionId: id,
        liquidity: 1n,
        usedTokenA: 0n,
        usedTokenB: 0n,
        returnTokenA: 0n,
        returnTokenB: 0n,
        swappedFromTokenA: 0n,
        swappedFromTokenB: 0n,
        swappedToTokenA: 0n,
        swappedToTokenB: 0n,
        remainingTokenA: this.cashA,
        remainingTokenB: this.cashB,
        slippageHit: false,
      };
    }

    removePosition(positionId: string, _actionCost?: unknown) {
      const index = this.positions.findIndex((p) => p.id === positionId);
      if (index >= 0) {
        this.positions.splice(index, 1);
        return true;
      }
      return false;
    }

    updateAllPositionFees() {}

    getAllPositions() {
      return this.positions.slice();
    }
  }

  type SegmentRecord = { id: string; tickLower: number; tickUpper: number };

  let manager: VirtualPositionManager;
  let strategy: ThreeBandRebalancerStrategy;
  const now = Date.now();

  beforeEach(() => {
    pool = createTestPool();
    const fake = new FakeManager(pool);
    fake.setInitialBalances(50_000n, 50_000n);
    manager = fake as unknown as VirtualPositionManager;
    strategy = new ThreeBandRebalancerStrategy(manager, pool, {
      segmentRangePercent: 0.001,
      checkIntervalMs: 60_000,
      maxSwapSlippageBps: 500,
      bootstrapMaxSwapSlippageBps: 500,
      bootstrapAttempts: 1,
      segmentCount: 3,
      fastSegmentCount: 1,
      fastIntervalMs: 1,
      slowIntervalMs: 1,
      minSegmentDwellMs: 0,
       minOutOfRangeMs: 0,
       rotationTickThreshold: 0,
       minRotationProfitTokenB: 0,
    });
    strategy.setCurrentTime(now);
  });

  it("creates contiguous segments around the current price", () => {
    const init = strategy.initialize();
    expect(init.action).toBe("create");
    expect(init.segments).toHaveLength(3);

    const segments = strategy.getSegments().sort((a, b) => a.tickLower - b.tickLower);
    const width = segments[0].tickUpper - segments[0].tickLower;
    expect(width).toBeGreaterThan(0);

    for (let i = 1; i < segments.length; i++) {
      expect(segments[i].tickLower).toBe(segments[i - 1].tickUpper);
    }

    const currentTick = pool.tickCurrent;
    const inRange = segments.some(
      (segment) => currentTick >= segment.tickLower && currentTick < segment.tickUpper
    );
    expect(inRange).toBe(true);
  });

  it("rotates upward when price exceeds the highest band", () => {
    strategy.initialize();
    const segmentsBefore = strategy.getSegments().sort((a, b) => a.tickLower - b.tickLower);
    const width = segmentsBefore[0].tickUpper - segmentsBefore[0].tickLower;

    // Move price above the highest segment and advance time beyond the interval
    pool.tickCurrent = segmentsBefore[segmentsBefore.length - 1].tickUpper + width;
    strategy.setCurrentTime(now + 61_000);

    const result = strategy.execute();
    expect(result.action).toBe("rebalance");

    const segmentsAfter = strategy.getSegments().sort((a, b) => a.tickLower - b.tickLower);
    expect(segmentsAfter).toHaveLength(3);

    // Ensure segments remain contiguous
    for (let i = 1; i < segmentsAfter.length; i++) {
      expect(segmentsAfter[i].tickLower).toBe(segmentsAfter[i - 1].tickUpper);
    }

    const highSegment = segmentsAfter[segmentsAfter.length - 1];
    expect(pool.tickCurrent).toBeLessThanOrEqual(highSegment.tickUpper);
    expect(pool.tickCurrent).toBeGreaterThanOrEqual(highSegment.tickLower);
  });

  it("rotates downward when price drops below the lowest band", () => {
    strategy.initialize();
    const segmentsBefore = strategy.getSegments().sort((a, b) => a.tickLower - b.tickLower);
    const width = segmentsBefore[0].tickUpper - segmentsBefore[0].tickLower;

    pool.tickCurrent = segmentsBefore[0].tickLower - width;
    strategy.setCurrentTime(now + 61_000);

    const result = strategy.execute();
    expect(result.action).toBe("rebalance");

    const segmentsAfter = strategy.getSegments().sort((a, b) => a.tickLower - b.tickLower);
    expect(segmentsAfter).toHaveLength(3);

    for (let i = 1; i < segmentsAfter.length; i++) {
      expect(segmentsAfter[i].tickLower).toBe(segmentsAfter[i - 1].tickUpper);
    }

    const lowSegment = segmentsAfter[0];
    expect(pool.tickCurrent).toBeLessThanOrEqual(lowSegment.tickUpper);
    expect(pool.tickCurrent).toBeGreaterThanOrEqual(lowSegment.tickLower);
  });
});
