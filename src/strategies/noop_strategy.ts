import {
  type BacktestStrategy,
  type StrategyContext,
} from "../backtest_engine";
import { VirtualPositionManager } from "../virtual_position_mgr";
import { Pool } from "../pool";

export function strategyFactory(pool: Pool): BacktestStrategy {
  const manager = new VirtualPositionManager(pool);

  return {
    id: "noop",
    manager,
    async onInit(ctx: StrategyContext) {
      ctx.logger?.log?.(
        `[noop] start backtest at ${new Date(ctx.timestamp).toISOString()}`
      );
    },
    async onTick() {
      // no-op
    },
    async onEvent() {
      // no-op
    },
    async onFinish(ctx: StrategyContext) {
      ctx.logger?.log?.(
        `[noop] finish at ${new Date(ctx.timestamp).toISOString()}`
      );
    },
  };
}

export default strategyFactory;
