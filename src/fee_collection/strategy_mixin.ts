/**
 * Strategy Mixin for Enhanced Fee Collection
 * Provides easy integration of fee collection functionality into any strategy
 */

import { FeeCollectionManager } from "./fee_collection_manager";
import type {
  FeeCollectionConfig,
  PositionManager,
  PriceProvider,
  FeeCollectionAction,
  FeeCollectionAnalytics,
  CustomReinvestmentStrategy,
} from "./types";

/**
 * Mixin interface that strategies can implement to get fee collection capabilities
 */
export interface FeeCollectionCapable {
  feeCollectionManager?: FeeCollectionManager;

  // Methods that will be added by the mixin
  initializeFeeCollection?(config: FeeCollectionConfig): void;
  processFeeCollection?(currentTime?: number): FeeCollectionAction;
  getFeeCollectionAnalytics?(): FeeCollectionAnalytics;
  registerCustomReinvestmentStrategy?(
    strategy: CustomReinvestmentStrategy
  ): void;
  updateFeeCollectionConfig?(config: Partial<FeeCollectionConfig>): void;
  forceCollectFees?(currentTime?: number): FeeCollectionAction;
  forceReinvestment?(currentTime?: number): FeeCollectionAction;
}

/**
 * Mixin function to add fee collection capabilities to any strategy class
 */
export function withFeeCollection<T extends new (...args: any[]) => any>(
  BaseStrategy: T,
  positionManagerGetter: (instance: InstanceType<T>) => PositionManager,
  priceProviderGetter: (instance: InstanceType<T>) => PriceProvider
) {
  return class extends BaseStrategy implements FeeCollectionCapable {
    feeCollectionManager?: FeeCollectionManager;

    /**
     * Initialize fee collection with configuration
     */
    initializeFeeCollection(config: FeeCollectionConfig = {}) {
      const positionManager = positionManagerGetter(this as any);
      const priceProvider = priceProviderGetter(this as any);

      this.feeCollectionManager = new FeeCollectionManager(
        positionManager,
        priceProvider,
        config
      );
    }

    /**
     * Process fee collection - call this from your strategy's execute() method
     */
    processFeeCollection(
      currentTime: number = Date.now()
    ): FeeCollectionAction {
      if (!this.feeCollectionManager) {
        return { action: "none", message: "Fee collection not initialized" };
      }

      return this.feeCollectionManager.execute(currentTime);
    }

    /**
     * Get comprehensive fee collection analytics
     */
    getFeeCollectionAnalytics(): FeeCollectionAnalytics {
      if (!this.feeCollectionManager) {
        throw new Error("Fee collection not initialized");
      }

      return this.feeCollectionManager.getAnalytics();
    }

    /**
     * Register a custom reinvestment strategy
     */
    registerCustomReinvestmentStrategy(strategy: CustomReinvestmentStrategy) {
      if (!this.feeCollectionManager) {
        throw new Error("Fee collection not initialized");
      }

      this.feeCollectionManager.registerCustomStrategy(strategy);
    }

    /**
     * Update fee collection configuration at runtime
     */
    updateFeeCollectionConfig(config: Partial<FeeCollectionConfig>) {
      if (!this.feeCollectionManager) {
        throw new Error("Fee collection not initialized");
      }

      this.feeCollectionManager.updateConfig(config);
    }

    /**
     * Force fee collection (manual trigger)
     */
    forceCollectFees(currentTime: number = Date.now()): FeeCollectionAction {
      if (!this.feeCollectionManager) {
        throw new Error("Fee collection not initialized");
      }

      return this.feeCollectionManager.forceCollectFees(currentTime);
    }

    /**
     * Force reinvestment (manual trigger)
     */
    forceReinvestment(currentTime: number = Date.now()): FeeCollectionAction {
      if (!this.feeCollectionManager) {
        throw new Error("Fee collection not initialized");
      }

      return this.feeCollectionManager.forceReinvestment(currentTime);
    }

    /**
     * Get fee collection history
     */
    getFeeCollectionHistory() {
      if (!this.feeCollectionManager) {
        return [];
      }

      return this.feeCollectionManager.getFeeCollectionHistory();
    }

    /**
     * Get reinvestment history
     */
    getReinvestmentHistory() {
      if (!this.feeCollectionManager) {
        return [];
      }

      return this.feeCollectionManager.getReinvestmentHistory();
    }

    /**
     * Get current fee collection configuration
     */
    getFeeCollectionConfig() {
      if (!this.feeCollectionManager) {
        return null;
      }

      return this.feeCollectionManager.getConfig();
    }
  };
}

/**
 * Decorator function for easy integration
 */
export function EnableFeeCollection(
  config: FeeCollectionConfig = {},
  positionManagerProperty: string = "manager",
  priceProviderProperty: string = "pool"
) {
  return function <T extends new (...args: any[]) => any>(constructor: T) {
    return class extends constructor implements FeeCollectionCapable {
      feeCollectionManager?: FeeCollectionManager;

      constructor(...args: any[]) {
        super(...args);

        // Initialize fee collection after construction
        setTimeout(() => {
          this.initializeFeeCollection(config);
        }, 0);
      }

      initializeFeeCollection(feeConfig: FeeCollectionConfig = {}) {
        const positionManager = (this as any)[positionManagerProperty];
        const priceProvider = (this as any)[priceProviderProperty];

        if (!positionManager) {
          throw new Error(
            `Position manager not found at property: ${positionManagerProperty}`
          );
        }

        if (!priceProvider) {
          throw new Error(
            `Price provider not found at property: ${priceProviderProperty}`
          );
        }

        this.feeCollectionManager = new FeeCollectionManager(
          positionManager,
          priceProvider,
          { ...config, ...feeConfig }
        );
      }

      processFeeCollection(
        currentTime: number = Date.now()
      ): FeeCollectionAction {
        if (!this.feeCollectionManager) {
          return { action: "none", message: "Fee collection not initialized" };
        }

        return this.feeCollectionManager.execute(currentTime);
      }

      getFeeCollectionAnalytics(): FeeCollectionAnalytics {
        if (!this.feeCollectionManager) {
          throw new Error("Fee collection not initialized");
        }

        return this.feeCollectionManager.getAnalytics();
      }

      registerCustomReinvestmentStrategy(strategy: CustomReinvestmentStrategy) {
        if (!this.feeCollectionManager) {
          throw new Error("Fee collection not initialized");
        }

        this.feeCollectionManager.registerCustomStrategy(strategy);
      }

      updateFeeCollectionConfig(newConfig: Partial<FeeCollectionConfig>) {
        if (!this.feeCollectionManager) {
          throw new Error("Fee collection not initialized");
        }

        this.feeCollectionManager.updateConfig(newConfig);
      }

      forceCollectFees(currentTime: number = Date.now()): FeeCollectionAction {
        if (!this.feeCollectionManager) {
          throw new Error("Fee collection not initialized");
        }

        return this.feeCollectionManager.forceCollectFees(currentTime);
      }

      forceReinvestment(currentTime: number = Date.now()): FeeCollectionAction {
        if (!this.feeCollectionManager) {
          throw new Error("Fee collection not initialized");
        }

        return this.feeCollectionManager.forceReinvestment(currentTime);
      }
    };
  };
}

/**
 * Helper function to create a position manager adapter
 */
export function createPositionManagerAdapter(
  getPosition: (id: string) => any,
  collectFees: (id: string) => { fee0: bigint; fee1: bigint } | null,
  addToPosition: (id: string, amount0: bigint, amount1: bigint) => any,
  getTotals: () => {
    amountA: bigint;
    amountB: bigint;
    feesOwed0: bigint;
    feesOwed1: bigint;
    collectedFees0: bigint;
    collectedFees1: bigint;
  },
  getAllPositions: () => any[],
  getActivePositions?: () => any[]
): PositionManager {
  return {
    getPosition,
    collectFees,
    addToPosition,
    getTotals,
    getAllPositions,
    getActivePositions: getActivePositions || getAllPositions,
  };
}

/**
 * Helper function to create a price provider adapter
 */
export function createPriceProviderAdapter(
  getCurrentPrice: () => number,
  getCurrentTick: () => number
): PriceProvider {
  return {
    getCurrentPrice,
    getCurrentTick,
  };
}
