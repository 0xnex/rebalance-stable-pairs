import { VirtualPositionManager } from "./virtual_position_mgr";
import { PerformanceSummary } from "./performance_tracker";

export type PositionInfo = {
  id: string;
  tickLower: number;
  tickUpper: number;
  priceLower: number;
  priceUpper: number;
  midPrice: number;
  widthPercent: number;
  isActive: boolean;
  liquidity: string;
  amountA: string;
  amountB: string;
  distanceFromCurrentPercent: number;
};

export type BacktestReport = {
  poolId: string;
  startTime: number;
  endTime: number;
  stepMs: number;
  eventsProcessed: number;
  ticks: number;
  strategyId: string;
  totals: ReturnType<VirtualPositionManager["getTotals"]>;
  performance: PerformanceSummary;
  finalState: {
    currentPrice: number;
    currentTick: number;
    liquidity: string;
    openPositions: PositionInfo[];
  };
};
