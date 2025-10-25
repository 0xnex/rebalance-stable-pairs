#!/bin/bash

bun run src/strategies/three_band_pyramid_strategy_runner.ts \
  --poolId  0x7aa448e4e16d5fde0e1f12ca26826b5bc72921bea5067f6f12fd7e298e2655f9 \
  --dataDir ../mmt_txs/0x7aa448e4e16d5fde0e1f12ca26826b5bc72921bea5067f6f12fd7e298e2655f9 \
  --token0Name LBTC \
  --token1Name WBTC \
  --decimals0 8 \
  --decimals1 8 \
  --feeTier 1000 \
  --tickIntervalMs 1000 \
  --tickSpacing 2 \
  --initialAmount0 0 \
  --initialAmount1 1000000000 \
  --start "2025-08-20T00:00:00Z" \
  --end "2025-10-10T00:00:00Z" \
  --output ./backtest-results/three_band_pyramid/ \
  --band1-width 2 \
  --band2-width 4 \
  --band3-width 8 \
  --band1-alloc 30 \
  --band2-alloc 30 \
  --band3-alloc 40 \
  --outside-duration 600000 \
  --cooldown 300000