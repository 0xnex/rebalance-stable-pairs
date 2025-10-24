#!/bin/bash

# Quick Strategy Comparison Script
# Usage: ./scripts/compare_strategies.sh <poolId> <start> <end>

POOL_ID="${1:-0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9}"
START="${2:-2025-08-20T00:00:00Z}"
END="${3:-2025-08-21T00:00:00Z}"

echo "╔══════════════════════════════════════════════════════════╗"
echo "║          STRATEGY COMPARISON RUNNER                      ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Pool ID: $POOL_ID"
echo "Period:  $START to $END"
echo ""

# Test each strategy
for strategy in noop example three-band; do
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "Testing strategy: $strategy"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  
  bun run src/backtest.ts \
    --strategy "$strategy" \
    --poolId "$POOL_ID" \
    --start "$START" \
    --end "$END" \
    --token0 USDC \
    --token1 USDT \
    --init0 10000000 \
    --init1 10000000 \
    --output "./results-$strategy"
  
  echo ""
done

echo "╔══════════════════════════════════════════════════════════╗"
echo "║          ALL STRATEGIES TESTED!                          ║"
echo "╚══════════════════════════════════════════════════════════╝"
echo ""
echo "Results saved in:"
echo "  - ./results-noop/"
echo "  - ./results-example/"
echo "  - ./results-three-band/"
echo ""
echo "Compare fund performance:"
echo "  diff results-noop/fund_performance_*.csv results-three-band/fund_performance_*.csv"
echo ""

