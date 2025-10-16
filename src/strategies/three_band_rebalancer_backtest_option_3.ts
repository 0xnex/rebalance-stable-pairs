import type { BacktestStrategy, StrategyContext } from "../backtest_engine";
import { VirtualPositionManager } from "../virtual_position_mgr";
import { Pool } from "../pool";
import {
    ThreeBandRebalancerStrategy,
    type ThreeBandRebalancerConfig,
} from "./three_band_rebalancer_strategy";
import * as fs from "fs";

type EnvConfig = {
    initialAmountA: bigint;
    initialAmountB: bigint;
    segmentRangePercent: number;
    segmentCount: number;
    checkIntervalMs: number;
    maxSwapSlippageBps: number;
    bootstrapMaxSwapSlippageBps: number;
    bootstrapAttempts: number;
    actionCostTokenA: number;
    actionCostTokenB: number;
    fastSegmentCount: number;
    fastIntervalMs: number;
    slowIntervalMs: number;
    minSegmentDwellMs: number;
    minOutOfRangeMs: number;
    rotationTickThreshold: number;
    minRotationProfitTokenB: number;
    enableDynamicAllocation: boolean;
    enableAdaptiveBandWidth: boolean;
    enablePredictiveRotation: boolean;
    enableFeeCompounding: boolean;
    enableSmartSlippage: boolean;
    feeCompoundingThresholdPercent: number;
    volatilityWindowMs: number;
    momentumWindowSize: number;
    activeBandWeightPercent: number;
    // Option 3 specific configs
    enableHierarchicalRebalancing: boolean;
    hierarchicalCooldownMs: number;
    maxDailyRebalances: number;
    position1AllocationPercent: number;
    position2AllocationPercent: number;
    position3AllocationPercent: number;
    position1TickWidth: number;
    position2TickWidth: number;
    position3TickWidth: number;
};

function readEnvConfig(): EnvConfig {
    const toBigInt = (value: string | undefined, fallback: bigint) => {
        if (!value) return fallback;
        try {
            return BigInt(value);
        } catch {
            return fallback;
        }
    };

    const toNumber = (value: string | undefined, fallback: number) => {
        if (!value) return fallback;
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    };

    return {
        initialAmountA: toBigInt(process.env.THREEBAND_INITIAL_A, 0n),
        initialAmountB: toBigInt(process.env.THREEBAND_INITIAL_B, 10_000_000_000n), // 10B default in raw units
        segmentRangePercent: toNumber(process.env.THREEBAND_RANGE_PERCENT, 0.001),
        segmentCount: toNumber(process.env.THREEBAND_SEGMENT_COUNT, 3),
        checkIntervalMs: toNumber(process.env.THREEBAND_CHECK_INTERVAL_MS, 60_000),
        maxSwapSlippageBps: toNumber(process.env.THREEBAND_MAX_SLIPPAGE_BPS, 50),
        bootstrapMaxSwapSlippageBps: toNumber(
            process.env.THREEBAND_BOOTSTRAP_SLIPPAGE_BPS,
            200
        ),
        bootstrapAttempts: toNumber(process.env.THREEBAND_BOOTSTRAP_ATTEMPTS, 3),
        actionCostTokenA: toNumber(process.env.THREEBAND_ACTION_COST_A, 0),
        actionCostTokenB: toNumber(process.env.THREEBAND_ACTION_COST_B, 5000), // Raw units (not decimal)
        fastSegmentCount: toNumber(process.env.THREEBAND_FAST_COUNT, 3), // All bands are fast
        fastIntervalMs: toNumber(process.env.THREEBAND_FAST_INTERVAL_MS, 10_000),
        slowIntervalMs: toNumber(
            process.env.THREEBAND_SLOW_INTERVAL_MS,
            toNumber(process.env.THREEBAND_FAST_INTERVAL_MS, 10_000) // Default to fast interval
        ),
        minSegmentDwellMs: toNumber(
            process.env.THREEBAND_MIN_DWELL_MS,
            2 * 60 * 1000
        ),
        minOutOfRangeMs: toNumber(process.env.THREEBAND_MIN_OUT_MS, 2 * 60 * 1000),
        rotationTickThreshold: toNumber(
            process.env.THREEBAND_ROTATION_TICK_THRESHOLD,
            0
        ),
        minRotationProfitTokenB: toNumber(process.env.THREEBAND_MIN_PROFIT_B, 0), // Raw units (not decimal)

        // Enhanced features - ALL DISABLED for simplicity
        enableDynamicAllocation: false,
        enableAdaptiveBandWidth: false,
        enablePredictiveRotation: false,
        enableFeeCompounding: false,
        enableSmartSlippage: false,
        feeCompoundingThresholdPercent: 1.0,
        volatilityWindowMs: 600_000,
        momentumWindowSize: 5,
        activeBandWeightPercent: 33.33, // Not used when enableDynamicAllocation=false

        // Option 3 specific configurations
        enableHierarchicalRebalancing: toNumber(process.env.THREEBAND_HIERARCHICAL, 1) === 1,
        hierarchicalCooldownMs: toNumber(process.env.THREEBAND_HIERARCHICAL_COOLDOWN_MS, 60 * 60 * 1000), // 1 hour
        maxDailyRebalances: toNumber(process.env.THREEBAND_MAX_DAILY_REBALANCES, 5),
        position1AllocationPercent: toNumber(process.env.THREEBAND_POS1_ALLOCATION, 60), // 60%
        position2AllocationPercent: toNumber(process.env.THREEBAND_POS2_ALLOCATION, 20), // 20%
        position3AllocationPercent: toNumber(process.env.THREEBAND_POS3_ALLOCATION, 20), // 20%
        position1TickWidth: toNumber(process.env.THREEBAND_POS1_TICK_WIDTH, 2), // 2 ticks
        position2TickWidth: toNumber(process.env.THREEBAND_POS2_TICK_WIDTH, 4), // 4 ticks
        position3TickWidth: toNumber(process.env.THREEBAND_POS3_TICK_WIDTH, 4), // 4 ticks
    };
}

export function strategyFactory(pool: Pool): BacktestStrategy {
    const env = readEnvConfig();
    const manager = new VirtualPositionManager(pool);
    manager.setInitialBalances(env.initialAmountA, env.initialAmountB);

    // CSV file writer for separate output
    const csvFilePath = `three_band_option3_backtest_${Date.now()}.csv`;
    let csvInitialized = false;

    // Track rebalancing history for Option 3 constraints
    let lastRebalanceTime = 0;
    let dailyRebalanceCount = 0;
    let lastRebalanceDate = new Date().toDateString();

    const config: Partial<ThreeBandRebalancerConfig> = {
        segmentCount: env.segmentCount,
        segmentRangePercent: env.segmentRangePercent,
        maxSwapSlippageBps: env.maxSwapSlippageBps,
        bootstrapMaxSwapSlippageBps: env.bootstrapMaxSwapSlippageBps,
        bootstrapAttempts: env.bootstrapAttempts,
        actionCostTokenA: env.actionCostTokenA,
        actionCostTokenB: env.actionCostTokenB,
        fastSegmentCount: env.fastSegmentCount,
        fastIntervalMs: env.fastIntervalMs,
        slowIntervalMs: env.slowIntervalMs,
        minSegmentDwellMs: env.minSegmentDwellMs,
        minOutOfRangeMs: env.minOutOfRangeMs,
        rotationTickThreshold: env.rotationTickThreshold,
        minRotationProfitTokenB: env.minRotationProfitTokenB,
        enableDynamicAllocation: env.enableDynamicAllocation,
        enableAdaptiveBandWidth: env.enableAdaptiveBandWidth,
        enablePredictiveRotation: env.enablePredictiveRotation,
        enableFeeCompounding: env.enableFeeCompounding,
        enableSmartSlippage: env.enableSmartSlippage,
        feeCompoundingThresholdPercent: env.feeCompoundingThresholdPercent,
        volatilityWindowMs: env.volatilityWindowMs,
        momentumWindowSize: env.momentumWindowSize,
        activeBandWeightPercent: env.activeBandWeightPercent,
    };

    const strategy = new ThreeBandRebalancerStrategy(manager, pool, config);
    let lastTimestamp = -1;
    let lastLogKey: string | null = null;

    // Helper function to check if rebalancing is allowed (Option 3 constraints)
    const canRebalance = (ctx: StrategyContext): { allowed: boolean; reason: string } => {
        const now = ctx.timestamp;
        const currentDate = new Date(now).toDateString();

        // Reset daily counter if new day
        if (currentDate !== lastRebalanceDate) {
            dailyRebalanceCount = 0;
            lastRebalanceDate = currentDate;
        }

        // Check daily limit
        if (dailyRebalanceCount >= env.maxDailyRebalances) {
            return { allowed: false, reason: `Daily limit reached (${env.maxDailyRebalances} rebalances)` };
        }

        // Check cooldown
        if (now - lastRebalanceTime < env.hierarchicalCooldownMs) {
            const remaining = env.hierarchicalCooldownMs - (now - lastRebalanceTime);
            return { allowed: false, reason: `Cooldown active, ${Math.ceil(remaining / 1000)}s remaining` };
        }

        return { allowed: true, reason: "Rebalancing allowed" };
    };

    // Helper function to determine rebalancing case based on price
    const getRebalancingCase = (currentPrice: number): { case: number; description: string } => {
        // Price thresholds based on Option 3 specification
        // Assuming base price around 1.0000 for stablecoin pairs
        const basePrice = 1.0000;
        const pos1Lower = basePrice * 0.99965; // -0.035% (roughly -1 tick)
        const pos1Upper = basePrice * 1.00035; // +0.035% (roughly +1 tick)
        const pos2Lower = basePrice * 1.00015; // +0.015% (roughly +2 ticks)
        const pos2Upper = basePrice * 1.00115; // +0.115% (roughly +5 ticks)
        const pos3Lower = basePrice * 0.99935; // -0.065% (roughly -5 ticks)
        const pos3Upper = basePrice * 0.99985; // -0.015% (roughly -2 ticks)

        if (currentPrice >= pos1Lower && currentPrice <= pos1Upper) {
            return { case: 3, description: "Price within Position 1 range - No action" };
        } else if (currentPrice > pos1Upper && currentPrice <= pos2Upper) {
            return { case: 1, description: "Price above Position 1 - Rebalance Position 1" };
        } else if (currentPrice < pos1Lower && currentPrice >= pos3Lower) {
            return { case: 1, description: "Price below Position 1 - Rebalance Position 1" };
        } else if (currentPrice > pos2Upper || currentPrice < pos3Lower) {
            return { case: 2, description: "Price outside all positions - Full rebalance" };
        } else {
            return { case: 1, description: "Price in Position 2/3 range - Rebalance Position 1" };
        }
    };

    const log = (ctx: StrategyContext, action: string, message: string) => {
        const key = `${action}:${message}`;
        if (lastLogKey === key) return;
        lastLogKey = key;

        // Get current state for detailed logging
        const tick = pool.tickCurrent;
        const price = pool.price;
        const totals = manager.getTotals();
        const positions = manager.getAllPositions();

        // Calculate total value and breakdown (keep raw values)
        const amountA = Number(totals.amountA);
        const amountB = Number(totals.amountB);
        const valueA = amountA * price;
        const valueB = amountB;
        const totalValue = valueA + valueB;

        // Count in-range positions
        let inRangeCount = 0;
        for (const pos of positions) {
            if (tick >= pos.tickLower && tick < pos.tickUpper) {
                inRangeCount++;
            }
        }

        // Calculate fees (keep as BigInt to avoid overflow)
        const feesOwedA = totals.feesOwed0 ?? 0n;
        const feesOwedB = totals.feesOwed1 ?? 0n;
        const feesCollectedA = totals.collectedFees0 ?? 0n;
        const feesCollectedB = totals.collectedFees1 ?? 0n;
        const totalFeesA = feesOwedA + feesCollectedA;
        const totalFeesB = feesOwedB + feesCollectedB;

        // Determine rebalancing case for Option 3
        const rebalancingCase = getRebalancingCase(price);
        const rebalanceCheck = canRebalance(ctx);

        // Main log line with Option 3 specific context
        ctx.logger?.log?.(
            `[three-band-option3] ${new Date(
                ctx.timestamp
            ).toISOString()} action=${action} msg=${message} | tick=${tick} price=${price.toFixed(
                6
            )} | value=${totalValue.toFixed(
                0
            )} (A:${valueA.toFixed(
                0
            )} B:${valueB.toFixed(0)}) | positions=${positions.length
            } inRange=${inRangeCount} | fees=(A:${totalFeesA} B:${totalFeesB}) | Case=${rebalancingCase.case} (${rebalancingCase.description}) | Rebalance: ${rebalanceCheck.allowed ? 'ALLOWED' : 'BLOCKED'} (${rebalanceCheck.reason})`
        );

        // Log hierarchical allocation details
        if (action === "create" || action === "rebalance") {
            ctx.logger?.log?.(
                `[three-band-option3] Hierarchical allocation: Position1=${env.position1AllocationPercent}% (${env.position1TickWidth}ticks) Position2=${env.position2AllocationPercent}% (${env.position2TickWidth}ticks) Position3=${env.position3AllocationPercent}% (${env.position3TickWidth}ticks)`
            );
        }

        // Log liquidity distribution on create action
        if (action === "create") {
            for (let i = 0; i < positions.length; i++) {
                const pos = positions[i];
                if (pos) {
                    const status =
                        tick >= pos.tickLower && tick < pos.tickUpper
                            ? "IN-RANGE"
                            : tick < pos.tickLower
                                ? "BELOW"
                                : "ABOVE";
                    const allocation = i === 0 ? env.position1AllocationPercent :
                        i === 1 ? env.position2AllocationPercent :
                            env.position3AllocationPercent;
                    ctx.logger?.log?.(
                        `[three-band-option3]   Position ${i + 1} (${allocation}%): [${pos.tickLower},${pos.tickUpper
                        }] ${status} liquidity=${pos.liquidity}`
                    );
                }
            }
        }

        // CSV format for Excel analysis (3 positions with Option 3 specific data)
        const csvParts: string[] = [
            new Date(ctx.timestamp).toISOString(),
            tick.toString(),
            price.toFixed(6),
            action,
            inRangeCount.toString(),
            rebalancingCase.case.toString(),
            rebalanceCheck.allowed ? "1" : "0",
            dailyRebalanceCount.toString(),
        ];

        // Add position data (3 positions for three-band strategy)
        const maxPositions = 3;
        for (let i = 0; i < maxPositions; i++) {
            if (i < positions.length && positions[i]) {
                const pos = positions[i]!;
                const posInRange =
                    tick >= pos.tickLower && tick < pos.tickUpper ? "1" : "0";
                const posFeesA = pos.tokensOwed0.toString();
                const posFeesB = pos.tokensOwed1.toString();
                const allocation = i === 0 ? env.position1AllocationPercent :
                    i === 1 ? env.position2AllocationPercent :
                        env.position3AllocationPercent;

                // Check if position has liquidity
                if (pos.liquidity === 0n) {
                    ctx.logger?.log?.(
                        `[three-band-option3-warn] Position ${i + 1} [${pos.tickLower},${pos.tickUpper
                        }] has ZERO liquidity - failed to open or was fully closed`
                    );
                    csvParts.push(
                        pos.tickLower.toString(),
                        pos.tickUpper.toString(),
                        "0",
                        "0",
                        "0",
                        "0",
                        "0",
                        allocation.toString()
                    );
                } else {
                    // Calculate actual current amounts based on position's liquidity and current price
                    const { currentAmountA, currentAmountB } =
                        manager.calculatePositionAmounts(pos.id);

                    csvParts.push(
                        pos.tickLower.toString(),
                        pos.tickUpper.toString(),
                        currentAmountA.toString(),
                        currentAmountB.toString(),
                        posFeesA.toString(),
                        posFeesB.toString(),
                        posInRange,
                        allocation.toString()
                    );
                }
            } else {
                // Empty fields for missing positions
                csvParts.push("", "", "", "", "", "", "", "");
            }
        }

        // Calculate sum of position amounts (actual current amounts)
        let sumAmountA = 0n;
        let sumAmountB = 0n;
        for (const pos of positions) {
            const { currentAmountA, currentAmountB } =
                manager.calculatePositionAmounts(pos.id);
            sumAmountA += currentAmountA;
            sumAmountB += currentAmountB;
        }

        // Add cash balances to get true total
        const cashA = totals.cashAmountA ?? 0n;
        const cashB = totals.cashAmountB ?? 0n;
        const totalCurrentA = sumAmountA + cashA;
        const totalCurrentB = sumAmountB + cashB;

        // Add totals (sum of actual position amounts + cash)
        csvParts.push(
            totalCurrentA.toString(),
            totalCurrentB.toString(),
            totalFeesA.toString(),
            totalFeesB.toString()
        );

        // Write CSV to separate file
        if (!csvInitialized) {
            // Write header with Option 3 specific columns
            const csvHeader = [
                "timestamp",
                "tick",
                "price",
                "action",
                "in_range_count",
                "rebalancing_case",
                "rebalance_allowed",
                "daily_rebalance_count",
                "pos1_tick_lower",
                "pos1_tick_upper",
                "pos1_amount_a",
                "pos1_amount_b",
                "pos1_fee_a",
                "pos1_fee_b",
                "pos1_in_range",
                "pos1_allocation_percent",
                "pos2_tick_lower",
                "pos2_tick_upper",
                "pos2_amount_a",
                "pos2_amount_b",
                "pos2_fee_a",
                "pos2_fee_b",
                "pos2_in_range",
                "pos2_allocation_percent",
                "pos3_tick_lower",
                "pos3_tick_upper",
                "pos3_amount_a",
                "pos3_amount_b",
                "pos3_fee_a",
                "pos3_fee_b",
                "pos3_in_range",
                "pos3_allocation_percent",
                "total_amount_a",
                "total_amount_b",
                "total_fee_a",
                "total_fee_b",
            ];
            fs.writeFileSync(csvFilePath, csvHeader.join(",") + "\n");
            csvInitialized = true;
            ctx.logger?.log?.(`[three-band-option3] CSV output file: ${csvFilePath}`);
        }

        // Append data row
        fs.appendFileSync(csvFilePath, csvParts.join(",") + "\n");

        // Additional details for Option 3 specific logging
        if (action === "wait" || action === "rebalance") {
            const segments = strategy.getSegments();
            if (segments.length > 0) {
                const firstSeg = segments[0];
                const lastSeg = segments[segments.length - 1];

                if (firstSeg && lastSeg) {
                    let rangeStatus = "IN RANGE ✓";
                    if (tick < firstSeg.tickLower) {
                        rangeStatus = "BELOW RANGE ⬇️";
                    } else if (tick >= lastSeg.tickUpper) {
                        rangeStatus = "ABOVE RANGE ⬆️";
                    }

                    const lowerDist = tick - firstSeg.tickLower;
                    const upperDist = lastSeg.tickUpper - tick;

                    ctx.logger?.log?.(
                        `[three-band-option3]   → Range: [${firstSeg.tickLower}, ${lastSeg.tickUpper}] | Status: ${rangeStatus} | Distance: lower=${lowerDist}ticks upper=${upperDist}ticks`
                    );

                    // Show Option 3 specific constraints
                    if (message.includes("rotating") || message.includes("Waiting")) {
                        const now = ctx.timestamp;
                        const cooldownRemaining = Math.max(0, env.hierarchicalCooldownMs - (now - lastRebalanceTime));
                        const dailyRemaining = Math.max(0, env.maxDailyRebalances - dailyRebalanceCount);

                        ctx.logger?.log?.(
                            `[three-band-option3]   → Option 3 Constraints: Cooldown=${Math.ceil(cooldownRemaining / 1000)}s Daily=${dailyRemaining}/${env.maxDailyRebalances}`
                        );
                    }
                }
            }
        }
    };

    const runOnce = (ctx: StrategyContext) => {
        if (ctx.timestamp === lastTimestamp) {
            return;
        }
        lastTimestamp = ctx.timestamp;
        manager.updateAllPositionFees();
        strategy.setCurrentTime(ctx.timestamp);

        // Check Option 3 constraints before executing strategy
        const rebalanceCheck = canRebalance(ctx);
        const rebalancingCase = getRebalancingCase(pool.price);

        // Override strategy behavior based on Option 3 logic
        let outcome;
        if (!rebalanceCheck.allowed && (rebalancingCase.case === 1 || rebalancingCase.case === 2)) {
            // Block rebalancing due to constraints
            outcome = {
                action: "wait" as const,
                message: `Option 3 constraint: ${rebalanceCheck.reason}`
            };
        } else {
            // Execute normal strategy
            outcome = strategy.execute();

            // Track rebalancing for Option 3 constraints
            if (outcome.action === "rebalance") {
                lastRebalanceTime = ctx.timestamp;
                dailyRebalanceCount++;
            }
        }

        if (outcome.action !== "none") {
            log(ctx, outcome.action, outcome.message);
        }
    };

    return {
        id: "three-band-rebalancer-option3",
        manager,
        async onInit(ctx) {
            manager.updateAllPositionFees();
            strategy.setCurrentTime(ctx.timestamp);
            const result = strategy.initialize();
            log(ctx, result.action, result.message);
        },
        async onTick(ctx) {
            runOnce(ctx);
        },
        async onEvent(ctx) {
            runOnce(ctx);
        },
        async onFinish(ctx) {
            manager.updateAllPositionFees();
            strategy.setCurrentTime(ctx.timestamp);

            // Log state before closing positions
            const beforeTotals = manager.getTotals();
            ctx.logger?.log?.(
                `[three-band-option3] before closing: positions=${beforeTotals.positions} amountA=${beforeTotals.amountA} amountB=${beforeTotals.amountB} cashA=${beforeTotals.cashAmountA} cashB=${beforeTotals.cashAmountB}`
            );
            ctx.logger?.log?.(
                `[three-band-option3] initial investment: initialA=${beforeTotals.initialAmountA} initialB=${beforeTotals.initialAmountB}`
            );

            // Close all positions
            for (const segment of strategy.getSegments()) {
                manager.removePosition(segment.id, {
                    tokenA: env.actionCostTokenA > 0 ? env.actionCostTokenA : undefined,
                    tokenB: env.actionCostTokenB > 0 ? env.actionCostTokenB : undefined,
                });
            }

            // Log final state after closing positions
            const totals = manager.getTotals();
            ctx.logger?.log?.(`[three-band-option3] FINISH TOTALS:`);
            ctx.logger?.log?.(
                `  Positions (in open positions): amountA=${totals.amountA} amountB=${totals.amountB}`
            );
            ctx.logger?.log?.(
                `  Cash (free balance): cashA=${totals.cashAmountA} cashB=${totals.cashAmountB}`
            );
            ctx.logger?.log?.(
                `  Fees Owed: feesOwed0=${totals.feesOwed0} feesOwed1=${totals.feesOwed1}`
            );
            ctx.logger?.log?.(
                `  Fees Collected: collected0=${totals.collectedFees0} collected1=${totals.collectedFees1}`
            );
            ctx.logger?.log?.(
                `  Costs: costA=${totals.totalCostTokenA.toFixed(
                    4
                )} costB=${totals.totalCostTokenB.toFixed(4)}`
            );
            ctx.logger?.log?.(
                `  TOTAL VALUE: ${Number(totals.cashAmountA) +
                Number(totals.amountA) +
                Number(totals.collectedFees0) +
                Number(totals.feesOwed0)
                } A + ${Number(totals.cashAmountB) +
                Number(totals.amountB) +
                Number(totals.collectedFees1) +
                Number(totals.feesOwed1)
                } B`
            );
            ctx.logger?.log?.(
                `[three-band-option3] Option 3 Summary: Total rebalances today=${dailyRebalanceCount}/${env.maxDailyRebalances}`
            );
        },
    };
}

export default strategyFactory;
