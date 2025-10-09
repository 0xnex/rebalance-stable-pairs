import { describe, it, expect, beforeEach } from "bun:test";
import { Pool } from "../src/pool";
import { VirtualPositionManager } from "../src/virtual_position_mgr";
import { AdaptiveFeeRebalancerStrategy } from "../src/strategies/adaptive_fee_rebalancer_strategy";

function createTestPool(): Pool {
  const pool = new Pool(0.0001, 60, 100n);
  pool.reserveA = 1_000_000n;
  pool.reserveB = 1_000_000n;
  pool.sqrtPriceX64 = 18446744073709551616n; // ≈1.0 price
  pool.tickCurrent = 0;
  pool.liquidity = 1_000_000n;
  return pool;
}

describe("AdaptiveFeeRebalancerStrategy", () => {
  let pool: Pool;
  let manager: VirtualPositionManager;
  let strategy: AdaptiveFeeRebalancerStrategy;
  let now: number;

  beforeEach(() => {
    pool = createTestPool();
    manager = new VirtualPositionManager(pool);
    manager.setInitialBalances(0n, 10_000n);
    strategy = new AdaptiveFeeRebalancerStrategy(manager, pool, {
      baseRangePercent: 0.01,
      minRangePercent: 0.002,
      maxRangePercent: 0.1,
      evaluationIntervalMs: 1_000,
      cooldownMs: 0,
      maxRebalancesPerHour: 10,
      feeTargetPerIntervalTokenB: 10,
      feePerformanceHysteresisPct: 0,
      widenMultiplier: 2,
      narrowMultiplier: 0.5,
      minRangeChangePct: 5,
      maxSwapSlippageBps: 100,
      actionCostTokenB: 0,
      bootstrapRangePercent: 0.01,
      bootstrapMaxSwapSlippageBps: 100,
      bootstrapAttempts: 1,
    });
    now = Date.now();
    strategy.setCurrentTime(now);
  });

  it("opens an initial position using available balances", () => {
    const result = strategy.execute();
    expect(result.action).toBe("create");
    expect(result.positionId).toBeDefined();

    const state = strategy.getState();
    expect(state.positionId).toBe(result.positionId);
    expect(state.activeRangePercent).toBeCloseTo(0.01);
  });

  it("widens the range after fees miss the target interval", () => {
    const first = strategy.execute();
    expect(first.action).toBe("create");

    const initialState = strategy.getState();

    // Fast-forward beyond evaluation interval with no additional fees accrued
    strategy.setCurrentTime(now + 1_500);
    const result = strategy.execute();

    // Strategy should rebalance to a wider band because fee delta < target
    const rebalanceState = strategy.getState();
    expect(result.action).toBe("rebalance");
    expect(result.positionId).toBeDefined();
    expect(rebalanceState.activeRangePercent).toBeGreaterThan(
      initialState.activeRangePercent
    );
  });

  it("narrows the range when fees exceed the target interval", () => {
    const first = strategy.execute();
    expect(first.action).toBe("create");
    const initialState = strategy.getState();

    const internal = manager as unknown as { positions: Map<string, any> };
    const pos = internal.positions.get(initialState.positionId!);
    pos.tokensOwed1 = 5_000n;

    strategy.setCurrentTime(now + 1_500);
    const result = strategy.execute();
    const nextState = strategy.getState();

    expect(result.action).toBe("rebalance");
    expect(nextState.activeRangePercent).toBeLessThan(
      initialState.activeRangePercent
    );
  });
});
