# ========================================
# V1.2 Option A: Three-Band Rebalancer Strategy Configuration
# ========================================
# Token amounts and costs are in RAW UNITS (without decimal normalization)
# Token A = base token (lower address)
# Token B = quote token (higher address)
# All costs (ACTION_COST_B, MIN_PROFIT_B) are in Token B raw units (quote currency)

# Basic strategy configuration
export THREEBAND_INITIAL_A=0
export THREEBAND_INITIAL_B=10000000000  # 10B in raw units
export THREEBAND_RANGE_PERCENT=0.0001    # 0.01% base range
export THREEBAND_CHECK_INTERVAL_MS=60000
export THREEBAND_MAX_SLIPPAGE_BPS=50
export THREEBAND_BOOTSTRAP_SLIPPAGE_BPS=200
export THREEBAND_ACTION_COST_A=0
export THREEBAND_ACTION_COST_B=5000     # Raw units
export THREEBAND_FAST_INTERVAL_MS=600000  # V1.2: 10 minutes monitoring interval
export THREEBAND_MIN_DWELL_MS=120000    # 2 minutes
export THREEBAND_MIN_OUT_MS=120000      # 2 minutes

# Pool configuration
# Common fee tiers for stable pairs:
# - 100 ppm (0.01%) with tickSpacing=1 - very tight stable pairs
# - 500 ppm (0.05%) with tickSpacing=10 
# - 1000 ppm (0.1%) with tickSpacing=2
export POOL_FEE_RATE_PPM=100           # 0.01% fee
export POOL_TICK_SPACING=2             # Tick spacing for 0.01% pools

# ========================================
# V1.2 Option A Specific Configuration
# ========================================
# Rebalancing constraints (V1.2 Option A)
export THREEBAND_MAX_DAILY_REBALANCES=1  # V1.2: 1 rebalance per day maximum
export THREEBAND_MIN_REBALANCE_COOLDOWN_MS=600000  # V1.2: 10 minutes (600,000 ms) cooldown

# Position allocation - Equal distribution (V1.2 Option A)
export THREEBAND_POS1_ALLOCATION=33.33  # Position 1: 33.33%
export THREEBAND_POS2_ALLOCATION=33.33  # Position 2: 33.33%
export THREEBAND_POS3_ALLOCATION=33.34  # Position 3: 33.34% (rounding adjustment)

# Range multipliers - Contiguous bands (V1.2 Option A)
export THREEBAND_BASE_RANGE_MULTIPLIER=1.0    # Position 1: Base range × 1.0 (narrowest)
export THREEBAND_MEDIUM_RANGE_MULTIPLIER=1.5  # Position 2: Base range × 1.5 (medium)
export THREEBAND_WIDE_RANGE_MULTIPLIER=2.0    # Position 3: Base range × 2.0 (widest)

# Market indicators for entry conditions (V1.2 Option A)
export THREEBAND_TREND_SCORE=50   # Trend Score (0-100) - minimum 50 required for entry
export THREEBAND_SAFETY_SCORE=50  # Safety Score (0-100) - minimum 50 required for entry

# ========================================
# Run Backtest with V1.2 Option A Strategy
# ========================================
bun --expose-gc run src/enhanced_backtest_runner.ts \
    --poolId 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 \
    --dataDir ../mmt_txs/0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 \
    --start "2025-08-20T00:00:00Z" \
    --end "2025-09-01T00:00:00Z" \
    --step 1000 \
    --format csv \
    --strategy ./src/strategies/three_band_rebalancer_backtest_2.4.1.1.ts \
    --tokenAName suiUSDT \
    --tokenADecimals 6 \
    --tokenBName USDC \
    --tokenBDecimals 6 