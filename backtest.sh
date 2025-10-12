# Token amounts and costs are in RAW UNITS (without decimal normalization)
# Token A = base token (lower address)
# Token B = quote token (higher address)
# All costs (ACTION_COST_B, MIN_PROFIT_B) are in Token B raw units (quote currency)

# Capital Configuration
export THREEBAND_INITIAL_A=0
export THREEBAND_INITIAL_B=10000000000

# Action Costs (in raw units)
export THREEBAND_ACTION_COST_A=0
export THREEBAND_ACTION_COST_B=5000
export THREEBAND_MIN_PROFIT_B=0

# Position Configuration
export THREEBAND_RANGE_PERCENT=0.0001          # Band width (0.01% of price)
export THREEBAND_SEGMENT_COUNT=3               # Number of bands (always 3)

# Timing Configuration (all timing guards in one place)
export THREEBAND_FAST_INTERVAL_MS=10000        # Check every 10s
export THREEBAND_MIN_DWELL_MS=30000            # Position must be 30s old before rotating
export THREEBAND_MIN_OUT_MS=5000               # Wait 5s after going out of range
# Optional: FAST_COUNT (default=SEGMENT_COUNT), ROTATION_TICK_THRESHOLD (default=0)

# Slippage Configuration (in basis points, 1 bp = 0.01%)
# Pool swap fee is automatically loaded from on-chain data
export THREEBAND_MAX_SLIPPAGE_BPS=50
export THREEBAND_BOOTSTRAP_SLIPPAGE_BPS=200
export THREEBAND_BOOTSTRAP_ATTEMPTS=3

bun --expose-gc run src/enhanced_backtest_runner.ts \
    --poolId 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 \
    --start "2025-08-20T00:00:00Z" \
    --end "2025-09-12T00:00:00Z" \
    --step 1000 \
    --format csv \
    --strategy ./src/strategies/three_band_rebalancer_backtest.ts \
    --dataDir ../mmt_txs > three_band_rebalancer_backtest.log 2>&1
    