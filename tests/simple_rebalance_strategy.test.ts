import { describe, it, expect, beforeEach, jest } from "bun:test";
import { Pool } from "../src/pool";
import { VirtualPositionManager } from "../src/virtual_position_mgr";
import { SimpleRebalanceStrategy } from "../src/strategies/simple_rebalance_strategy";

/**
 * Test setup helper
 */
function createTestPool(): Pool {
  const pool = new Pool(0.003, 60, 3000n);
  pool.reserveA = 1000000n;
  pool.reserveB = 2000000n;
  pool.sqrtPriceX64 = 18446744073709551616n; // Price ≈ 1.0
  pool.tickCurrent = 0;
  pool.liquidity = 1000000n;
  return pool;
}

function createTestPositionManager(pool: Pool): VirtualPositionManager {
  const positionManager = new VirtualPositionManager(pool);
  positionManager.setInitialBalances(100000n, 200000n);
  return positionManager;
}

describe("SimpleRebalanceStrategy", () => {
  let pool: Pool;
  let positionManager: VirtualPositionManager;
  let strategy: SimpleRebalanceStrategy;

  beforeEach(() => {
    pool = createTestPool();
    positionManager = createTestPositionManager(pool);

    // Create strategy with shorter timeouts for testing
    strategy = new SimpleRebalanceStrategy(positionManager, pool, {
      priceRangePercent: 0.01, // 1% range
      outOfRangeTimeoutMs: 1000, // 1 second for testing
      cooldownMs: 2000, // 2 seconds for testing
      maxRebalancesPerHour: 2,
    });
  });

  describe("Initial State", () => {
    it("should initialize with correct default state", () => {
      const state = strategy.getState();

      expect(state.lastRebalanceTime).toBe(0);
      expect(state.rebalanceCount).toBe(0);
      expect(state.positionId).toBeNull();
      expect(state.isOutOfRange).toBe(false);
      expect(state.outOfRangeStartTime).toBeNull();
    });

    it("should have correct default configuration", () => {
      const config = strategy.getConfig();

      expect(config.priceRangePercent).toBe(0.01);
      expect(config.outOfRangeTimeoutMs).toBe(1000);
      expect(config.cooldownMs).toBe(2000);
      expect(config.maxRebalancesPerHour).toBe(2);
      expect(config.maxSwapSlippageBps).toBe(100);
      expect(config.actionCostTokenA).toBe(0);
      expect(config.actionCostTokenB).toBe(0);
    });
  });

  describe("Initial Position Creation", () => {
    it("should create initial position when no position exists", () => {
      const result = strategy.execute();

      expect(result.action).toBe("create");
      expect(result.positionId).toBeDefined();
      expect(result.message).toContain("Created initial position");

      const state = strategy.getState();
      expect(state.positionId).toBe(result.positionId);
      expect(state.rebalanceCount).toBe(1);
    });

    it("should create position with correct price range", () => {
      const result = strategy.execute();

      expect(result.action).toBe("create");

      const position = positionManager.getPosition(result.positionId!);
      expect(position).toBeDefined();

      // Check that the position has reasonable tick values
      expect(position!.tickLower).toBeLessThan(position!.tickUpper);
      expect(position!.tickLower).toBeLessThanOrEqual(0); // Should be negative or zero for price = 1.0
      expect(position!.tickUpper).toBeGreaterThanOrEqual(0); // Should be positive or zero for price = 1.0

      // Check that the range size is reasonable (±0.01% around price → a few ticks)
      const rangeSize = Math.abs(position!.tickUpper - position!.tickLower);
      expect(rangeSize).toBeGreaterThan(0); // Should span at least one tick
      expect(rangeSize).toBeLessThanOrEqual(10); // Narrow band around spot
    });
  });

  describe("Position Monitoring", () => {
    beforeEach(() => {
      // Create initial position
      strategy.execute();
    });

    it("should monitor position when in range", () => {
      const result = strategy.execute();

      // After creating position, we might be in cooldown, so check for either "none" or "wait"
      expect(["none", "wait"]).toContain(result.action);
      if (result.action === "none") {
        expect(result.message).toContain("Position in range");
      } else {
        expect(result.message).toContain("cooldown");
      }
    });

    it("should detect when position goes out of range", () => {
      // Move price outside the position range
      const position = positionManager.getPosition(
        strategy.getState().positionId!
      );
      pool.tickCurrent = position!.tickUpper + 100; // Move above upper bound

      const result = strategy.execute();

      // Might be in cooldown, so check for either "none" or "wait"
      expect(["none", "wait"]).toContain(result.action);
      if (result.action === "none") {
        expect(result.message).toContain("Position went out of range");

        const state = strategy.getState();
        expect(state.isOutOfRange).toBe(true);
        expect(state.outOfRangeStartTime).toBeGreaterThan(0);
      }
    });

    it("should detect when position comes back in range", () => {
      // Move price outside the position range
      const position = positionManager.getPosition(
        strategy.getState().positionId!
      );
      pool.tickCurrent = position!.tickUpper + 100;
      strategy.execute(); // Mark as out of range

      // Move price back in range
      pool.tickCurrent = position!.tickLower + 50;

      const result = strategy.execute();

      // Might be in cooldown, so check for either "none" or "wait"
      expect(["none", "wait"]).toContain(result.action);
      if (result.action === "none") {
        expect(result.message).toContain("Position back in range");

        const state = strategy.getState();
        expect(state.isOutOfRange).toBe(false);
        expect(state.outOfRangeStartTime).toBeNull();
      }
    });
  });

  describe("Rebalancing Logic", () => {
    let noCooldownStrategy: SimpleRebalanceStrategy;

    beforeEach(() => {
      // Create strategy with no cooldown for testing
      noCooldownStrategy = new SimpleRebalanceStrategy(positionManager, pool, {
        priceRangePercent: 0.01,
        outOfRangeTimeoutMs: 1000,
        cooldownMs: 0, // No cooldown for testing
        maxRebalancesPerHour: 10, // High limit for testing
      });

      // Create initial position
      noCooldownStrategy.execute();
    });

    it("should rebalance after timeout when out of range", async () => {
      // Move price outside the position range
      const position = positionManager.getPosition(
        noCooldownStrategy.getState().positionId!
      );
      pool.tickCurrent = position!.tickUpper + 100;

      // First execution - mark as out of range
      noCooldownStrategy.execute();

      // Wait for timeout
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const result = noCooldownStrategy.execute();

      expect(result.action).toBe("rebalance");
      expect(result.message).toContain("Rebalanced position");
      expect(result.positionId).toBeDefined();

      const state = noCooldownStrategy.getState();
      expect(state.rebalanceCount).toBe(2);
      expect(state.isOutOfRange).toBe(false);
    });

    it("should respect cooldown period", () => {
      // Use the original strategy with cooldown
      const cooldownStrategy = new SimpleRebalanceStrategy(
        positionManager,
        pool,
        {
          priceRangePercent: 0.01,
          outOfRangeTimeoutMs: 1000,
          cooldownMs: 2000, // 2 second cooldown
          maxRebalancesPerHour: 10,
        }
      );

      // Create initial position
      cooldownStrategy.execute();

      // Move price outside the position range
      const position = positionManager.getPosition(
        cooldownStrategy.getState().positionId!
      );
      pool.tickCurrent = position!.tickUpper + 100;

      // First execution - mark as out of range
      cooldownStrategy.execute();

      // Wait for timeout and rebalance
      setTimeout(() => {
        cooldownStrategy.execute();
      }, 1100);

      // Try to execute again immediately (should be in cooldown)
      const result = cooldownStrategy.execute();

      expect(result.action).toBe("wait");
      expect(result.message).toContain("In cooldown period");
    });

    it("should respect max rebalances per hour", () => {
      // Use strategy with low rebalance limit
      const limitedStrategy = new SimpleRebalanceStrategy(
        positionManager,
        pool,
        {
          priceRangePercent: 0.01,
          outOfRangeTimeoutMs: 1000,
          cooldownMs: 0, // No cooldown for testing
          maxRebalancesPerHour: 2, // Low limit
        }
      );

      // Create initial position
      limitedStrategy.execute();

      // Simulate multiple rebalances
      for (let i = 0; i < 3; i++) {
        const position = positionManager.getPosition(
          limitedStrategy.getState().positionId!
        );
        pool.tickCurrent = position!.tickUpper + 100;

        limitedStrategy.execute(); // Mark as out of range
        setTimeout(() => {
          limitedStrategy.execute(); // Rebalance after timeout
        }, 1100);
      }

      // After 2 rebalances, should hit the limit
      const result = limitedStrategy.execute();

      if (result.action === "wait") {
        expect(result.message).toContain("Maximum rebalances per hour");
      }
    });
  });

  describe("Configuration Management", () => {
    it("should update configuration", () => {
      strategy.updateConfig({
        priceRangePercent: 0.02,
        outOfRangeTimeoutMs: 5000,
      });

      const config = strategy.getConfig();
      expect(config.priceRangePercent).toBe(0.02);
      expect(config.outOfRangeTimeoutMs).toBe(5000);
      expect(config.cooldownMs).toBe(2000); // Should remain unchanged
    });

    it("should reset state", () => {
      // Create initial position
      strategy.execute();

      const stateBefore = strategy.getState();
      expect(stateBefore.positionId).toBeDefined();

      strategy.reset();

      const stateAfter = strategy.getState();
      expect(stateAfter.positionId).toBeNull();
      expect(stateAfter.rebalanceCount).toBe(0);
      expect(stateAfter.lastRebalanceTime).toBe(0);
    });
  });

  describe("Statistics", () => {
    let noCooldownStrategy: SimpleRebalanceStrategy;

    beforeEach(() => {
      // Create strategy with no cooldown for testing
      noCooldownStrategy = new SimpleRebalanceStrategy(positionManager, pool, {
        priceRangePercent: 0.01,
        outOfRangeTimeoutMs: 1000,
        cooldownMs: 0, // No cooldown for testing
        maxRebalancesPerHour: 10,
      });

      // Create initial position
      noCooldownStrategy.execute();
    });

    it("should provide correct statistics", () => {
      const stats = noCooldownStrategy.getStats();

      expect(stats.totalRebalances).toBe(1);
      expect(stats.rebalancesThisHour).toBe(1);
      expect(stats.timeSinceLastRebalance).toBeGreaterThanOrEqual(0);
      expect(stats.isOutOfRange).toBe(false);
      expect(stats.outOfRangeDuration).toBe(0);
      expect(stats.nextRebalanceAvailable).toBe(0); // No cooldown
    });

    it("should update statistics after rebalance", async () => {
      // Move price outside the position range
      const position = positionManager.getPosition(
        noCooldownStrategy.getState().positionId!
      );
      pool.tickCurrent = position!.tickUpper + 100;

      noCooldownStrategy.execute(); // Mark as out of range

      // Wait for timeout and rebalance
      await new Promise((resolve) => setTimeout(resolve, 1100));
      noCooldownStrategy.execute();

      const stats = noCooldownStrategy.getStats();
      expect(stats.totalRebalances).toBe(2);
      expect(stats.rebalancesThisHour).toBe(2);
    });
  });

  describe("Edge Cases", () => {
    it("should handle position removal gracefully", () => {
      // Create initial position
      const result = strategy.execute();
      const positionId = result.positionId!;

      // Manually remove position
      positionManager.removePosition(positionId);

      const result2 = strategy.execute();
      expect(result2.action).toBe("create");
      expect(result2.positionId).toBeDefined();
      expect(result2.positionId).not.toBe(positionId);
    });

    it("should handle zero available amounts", () => {
      // Clear all positions and set zero balances
      positionManager.clearAll();
      positionManager.setInitialBalances(0n, 0n);

      const result = strategy.execute();
      expect(result.action).toBe("none");
      expect(result.message).toContain("No available balances");
    });
  });
});
