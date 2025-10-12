#!/bin/bash
# Analyze rebalancing frequency from backtest logs

LOG_FILE="three_band_rebalancer_backtest.log"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "🔍 REBALANCING FREQUENCY ANALYSIS"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Get start and end times
START=$(grep -E "action=(create|seed)" "$LOG_FILE" | head -1 | cut -d' ' -f2)
END=$(grep "finish totals" "$LOG_FILE" | tail -1 | cut -d' ' -f2)

echo "📅 Period: $START → $END"
echo ""

# Count different actions
TOTAL_ACTIONS=$(grep -c "action=" "$LOG_FILE" || echo "0")
WAIT_COUNT=$(grep -c "action=wait" "$LOG_FILE" || echo "0")
REBALANCE_COUNT=$(grep -c "action=rebalance" "$LOG_FILE" || echo "0")
CREATE_COUNT=$(grep -c "action=create" "$LOG_FILE" || echo "0")

echo "📊 Action Summary:"
echo "   Total actions:    $TOTAL_ACTIONS"
echo "   • Wait:           $WAIT_COUNT ($(awk "BEGIN {printf \"%.2f\", $WAIT_COUNT/$TOTAL_ACTIONS*100}")%)"
echo "   • Rebalance:      $REBALANCE_COUNT ($(awk "BEGIN {printf \"%.4f\", $REBALANCE_COUNT/$TOTAL_ACTIONS*100}")%)"
echo "   • Create:         $CREATE_COUNT"
echo ""

if [ "$REBALANCE_COUNT" -gt 0 ]; then
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "🔄 Rebalance Events:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    grep "action=rebalance" "$LOG_FILE" | nl -w2 -s'. '
    echo ""
    
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    echo "📈 Rebalancing Rate:"
    echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    
    # Calculate time between rebalances
    if [ "$REBALANCE_COUNT" -ge 2 ]; then
        FIRST_REBALANCE=$(grep "action=rebalance" "$LOG_FILE" | head -1 | cut -d' ' -f2)
        LAST_REBALANCE=$(grep "action=rebalance" "$LOG_FILE" | tail -1 | cut -d' ' -f2)
        
        FIRST_TS=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${FIRST_REBALANCE%.000Z}" "+%s" 2>/dev/null)
        LAST_TS=$(date -j -f "%Y-%m-%dT%H:%M:%S" "${LAST_REBALANCE%.000Z}" "+%s" 2>/dev/null)
        
        if [ -n "$FIRST_TS" ] && [ -n "$LAST_TS" ]; then
            DURATION_SECS=$((LAST_TS - FIRST_TS))
            DURATION_HOURS=$((DURATION_SECS / 3600))
            AVG_HOURS=$((DURATION_HOURS / (REBALANCE_COUNT - 1)))
            
            echo "   First rebalance: $FIRST_REBALANCE"
            echo "   Last rebalance:  $LAST_REBALANCE"
            echo "   Duration:        $DURATION_HOURS hours"
            echo "   Average gap:     $AVG_HOURS hours (~$(awk "BEGIN {printf \"%.1f\", $AVG_HOURS/24}") days)"
        fi
    fi
    
    echo "   Total rebalances: $REBALANCE_COUNT"
    echo ""
else
    echo "✅ No rebalances occurred - positions stayed in range!"
    echo ""
fi

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "💡 CSV File Size vs Actual Activity:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "CSV rows represent TRACKING (snapshots every minute),"
echo "NOT rebalancing events."
echo ""
echo "For actual rebalancing, look at:"
echo "  • action=rebalance in logs"
echo "  • Position ID changes in CSV"
echo "  • transaction_count in reports"
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

