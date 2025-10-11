bun run backtest:json \
    --poolId 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 \
    --start "2025-08-20T00:00:00Z" \
    --end "2025-08-30T00:00:00Z" \
    --strategy ./src/strategies/three_band_rebalancer_backtest.ts \
    --output test_csv_snapshots.json
