/**
 * Enhanced Fee Collection Module
 * Export all public interfaces and utilities
 */

// Core functionality
export { FeeCollectionManager } from "./fee_collection_manager";

// Mixin and decorator utilities
export {
  withFeeCollection,
  EnableFeeCollection,
  createPositionManagerAdapter,
  createPriceProviderAdapter,
} from "./strategy_mixin";

// Types and interfaces
export type {
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
  FeeCollectionCapable,
} from "./types";

// Re-export mixin interface
export type { FeeCollectionCapable } from "./strategy_mixin";

