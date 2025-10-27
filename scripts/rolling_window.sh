#!/bin/bash

# Rolling Window Strategy Backtest
# Three equal-width positions that roll with price movement

bun run src/strategies/rolling_window_strategy_runner.ts \
  --poolId  0x7aa448e4e16d5fde0e1f12ca26826b5bc72921bea5067f6f12fd7e298e2655f9 \
  --dataDir ../mmt_txs/0x7aa448e4e16d5fde0e1f12ca26826b5bc72921bea5067f6f12fd7e298e2655f9 \
  --token0Name LBTC \
  --token1Name WBTC \
  --decimals0 8 \
  --decimals1 8 \
  --feeTier 0.01 \
  --tickIntervalMs 1000 \
  --tickSpacing 2 \
  --initialAmount0 0 \
  --initialAmount1 1000000000 \
  --start "2025-08-20T00:00:00Z" \
  --end "2025-10-10T00:00:00Z" \
  --output ./test-output/rolling_window/ \
  --position-width 4 \
  --outside-duration-second 1800 \
  --cooldown-second 300
