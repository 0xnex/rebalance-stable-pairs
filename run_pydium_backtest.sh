#!/bin/bash

# Pydium Three-Band Strategy Backtest Runner
# Usage: ./run_pydium_backtest.sh [pool_id] [data_dir]

set -e

# Default values
POOL_ID=${1:-"0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9"}
DATA_DIR=${2:-"../mmt_txs"}

echo "=== Pydium Three-Band Strategy Backtest ==="
echo "Pool ID: $POOL_ID"
echo "Data Directory: $DATA_DIR"
echo ""

# Set environment variables for strategy configuration
export PYDIUM_INITIAL_A=0
export PYDIUM_INITIAL_B=10000000000  # 10B in raw units
export PYDIUM_POS1_WIDTH=2           # Narrow position: 2 ticks
export PYDIUM_POS2_WIDTH=6           # Medium position: 6 ticks  
export PYDIUM_POS3_WIDTH=8           # Wide position: 8 ticks
export PYDIUM_POS1_ALLOC=30          # 30% allocation to narrow
export PYDIUM_POS2_ALLOC=30          # 30% allocation to medium
export PYDIUM_POS3_ALLOC=40          # 40% allocation to wide
export PYDIUM_COOLDOWN_MS=300000     # 5 minutes cooldown
export PYDIUM_MAX_REBALANCE_24H=48   # Max 48 rebalances per 24h
export PYDIUM_ACTION_COST_A=0        # No cost for token A
export PYDIUM_ACTION_COST_B=5000     # 5000 raw units for token B
export PYDIUM_MAX_SLIPPAGE_BPS=50    # 0.5% max slippage
export PYDIUM_BOOTSTRAP_SLIPPAGE_BPS=200  # 2% bootstrap slippage
export PYDIUM_BOOTSTRAP_ATTEMPTS=3   # 3 bootstrap attempts

echo "Strategy Configuration:"
echo "  Position 1 (Narrow): ${PYDIUM_POS1_WIDTH} ticks, ${PYDIUM_POS1_ALLOC}% allocation"
echo "  Position 2 (Medium): ${PYDIUM_POS2_WIDTH} ticks, ${PYDIUM_POS2_ALLOC}% allocation"
echo "  Position 3 (Wide):   ${PYDIUM_POS3_WIDTH} ticks, ${PYDIUM_POS3_ALLOC}% allocation"
echo "  Cooldown: ${PYDIUM_COOLDOWN_MS}ms"
echo "  Max rebalances/24h: ${PYDIUM_MAX_REBALANCE_24H}"
echo "  Action cost B: ${PYDIUM_ACTION_COST_B}"
echo ""

# Run the backtest
echo "Starting backtest..."
bun run test_pydium_strategy.ts --poolId "$POOL_ID" --dataDir "$DATA_DIR"

echo ""
echo "Backtest completed! Check the generated CSV file for detailed results."
