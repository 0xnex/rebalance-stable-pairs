#!/bin/bash

echo "🔍 Testing Enhanced Fee Reporting"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Running 10-minute backtest to demonstrate fee accumulation..."
echo ""

THREEBAND_INITIAL_A=0 \
THREEBAND_INITIAL_B=100000000000 \
THREEBAND_ACTION_COST_A=0 \
THREEBAND_ACTION_COST_B=0.02 \
THREEBAND_MIN_PROFIT_B=1 \
THREEBAND_RANGE_PERCENT=0.0001 \
THREEBAND_SEGMENT_COUNT=3 \
THREEBAND_FAST_COUNT=2 \
THREEBAND_FAST_INTERVAL_MS=30000 \
THREEBAND_SLOW_INTERVAL_MS=300000 \
THREEBAND_MIN_DWELL_MS=60000 \
THREEBAND_MIN_OUT_MS=60000 \
THREEBAND_ROTATION_TICK_THRESHOLD=0 \
bun run src/enhanced_backtest_runner.ts \
  --poolId 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 \
  --start "2025-08-21T00:00:00Z" \
  --end "2025-08-21T00:10:00Z" \
  --step 1000 \
  --strategy ./src/strategies/three_band_rebalancer_backtest.ts \
  --dataDir ../mmt_txs 2>&1 | grep -A 20 "Position Status" | head -200

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Test complete! Check output above for per-minute fee details."
echo ""
echo "📚 Documentation: FEE_REPORTING_GUIDE.md"
echo ""
