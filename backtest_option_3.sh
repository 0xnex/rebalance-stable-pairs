# Token amounts and costs are in RAW UNITS (without decimal normalization)
# Token A = base token (lower address)
# Token B = quote token (higher address)
# All costs (ACTION_COST_B, MIN_PROFIT_B) are in Token B raw units (quote currency)

# Basic strategy configuration
export THREEBAND_INITIAL_A=0
export THREEBAND_INITIAL_B=10000000000  # 10B in raw units
export THREEBAND_RANGE_PERCENT=0.0001    # 0.1%
export THREEBAND_CHECK_INTERVAL_MS=60000
export THREEBAND_MAX_SLIPPAGE_BPS=50
export THREEBAND_BOOTSTRAP_SLIPPAGE_BPS=200
export THREEBAND_ACTION_COST_A=0
export THREEBAND_ACTION_COST_B=5000     # Raw units
export THREEBAND_FAST_INTERVAL_MS=10000
export THREEBAND_MIN_DWELL_MS=120000    # 2 minutes
export THREEBAND_MIN_OUT_MS=120000      # 2 minutes

export THREEBAND_HIERARCHICAL=1
export THREEBAND_SEGMENT_COUNT=3
export THREEBAND_HIERARCHICAL_COOLDOWN_MS=3600000  # 1 hour
export THREEBAND_MAX_DAILY_REBALANCES=5
export THREEBAND_POS1_ALLOCATION=60  # 60%
export THREEBAND_POS2_ALLOCATION=20  # 20%
export THREEBAND_POS3_ALLOCATION=20  # 20%
export THREEBAND_POS1_TICK_WIDTH=2   # 2 ticks
export THREEBAND_POS2_TICK_WIDTH=4   # 4 ticks
export THREEBAND_POS3_TICK_WIDTH=4   # 4 ticks

bun --expose-gc run src/enhanced_backtest_runner.ts \
    --poolId 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 \
    --start "2025-08-20T00:00:00Z" \
    --end "2025-09-12T00:00:00Z" \
    --step 1000 \
    --format csv \
    --strategy ./src/strategies/three_band_rebalancer_backtest_option_3.ts \
    --tokenAName suiUSDT \
    --tokenADecimals 6 \
    --tokenBName USDC \
    --tokenBDecimals 6 