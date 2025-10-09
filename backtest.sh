SIMPLE_INITIAL_A=0 \
SIMPLE_INITIAL_B=10000000000 \
ACTION_COST_TOKEN_B=20000 \
SIMPLE_PRICE_RANGE=0.005 \
SIMPLE_TIMEOUT_MS=60000 \
SIMPLE_COOLDOWN_MS=60000 \
ENABLE_DYNAMIC_ALLOCATION=true \
  bun run src/backtest_runner.ts \
    --poolId 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 \
    --start "2025-08-20T00:00:00Z" \
    --end "2025-08-30T00:00:00Z" \
    --step 1000 \
    --strategy ./src/strategies/three_band_rebalancer_backtest.ts \
    --dataDir ../mmt_txs > three_band_rebalancer_backtest.log 2>&1