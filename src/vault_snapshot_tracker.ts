/**
 * Vault Snapshot Tracker
 * Theo dõi trạng thái vault trong quá trình backtest với interval 1 phút
 */

import * as fs from 'fs';
import * as path from 'path';
import { VirtualPositionManager } from './virtual_position_mgr';
import { Pool } from './pool';

export interface CollateralAnalysis {
    collateralToken: string;
    pendingRedemptions: number;
    collateralAmount: number;
    collateralValueUSD: number;
    pendingRedemptionsUSD: number;
    isRequirementMet: boolean;
    deficit: number;
    surplus: number;
}

export interface InvestmentOptimization {
    investmentUSD: number;
    investmentRatio: number;
    targetTokenAValue: number;
    targetTokenBValue: number;
    optimalSwaps: SwapPlan[];
    totalSwapValue: number;
    swapEfficiency: number;
    avoidedRoundTrips: boolean;
    collateralProtected: number;
}

export interface SwapPlan {
    fromToken: string;
    toToken: string;
    swapValueUSD: number;
    swapAmountFrom: number;
    swapAmountTo: number;
    reason: string;
    routingType: 'optimal' | 'direct' | 'multi-hop';
    efficiency: number;
}

export interface VaultSnapshot {
    timestamp: number;
    timestampISO: string;
    totalValueUSD: number;
    cashBalances: {
        tokenA: string;
        tokenB: string;
        totalUSD: number;
        tokenAPrice: number;
        tokenBPrice: number;
    };
    positions: {
        count: number;
        totalLiquidity: string;
        activePositions: number;
        inRangePositions: number;
        outOfRangePositions: number;
        avgTickWidth: number;
    };
    fees: {
        collected0: string;
        collected1: string;
        owed0: string;
        owed1: string;
        totalFeesUSD: number;
        feeYieldAPR: number;
        feeYieldDaily: number;
    };
    performance: {
        totalReturn: number;
        totalReturnPct: number;
        unrealizedPnL: number;
        unrealizedPnLPct: number;
        realizedPnL: number;
        realizedPnLPct: number;
        roi: number;
        sharpeRatio: number;
        maxDrawdown: number;
        volatility: number;
    };
    costs: {
        totalCostTokenA: number;
        totalCostTokenB: number;
        totalCostUSD: number;
        avgCostBasis: number;
    };
    poolState: {
        currentTick: number;
        sqrtPriceX64: string;
        liquidity: string;
        feeGrowthGlobal0X64: string;
        feeGrowthGlobal1X64: string;
        volume24h: number;
        tvl: number;
    };
    priceInfo: {
        tokenAPrice: number;
        tokenBPrice: number;
        priceRatio: number;
        priceChange24h: number;
        volatility24h: number;
    };
    collateralAnalysis?: CollateralAnalysis;
    investmentOptimization?: InvestmentOptimization;
    riskMetrics: {
        valueAtRisk: number;
        expectedShortfall: number;
        beta: number;
        correlation: number;
    };
}

export class VaultSnapshotTracker {
    private snapshots: VaultSnapshot[] = [];
    private lastSnapshotTime: number = 0;
    private readonly snapshotInterval: number = 60 * 1000; // 1 phút
    private readonly outputDir: string;
    private initialValue: number = 0;

    constructor(
        private readonly positionManager: VirtualPositionManager,
        private readonly pool: Pool,
        outputDir: string = './snapshots'
    ) {
        this.outputDir = outputDir;
        this.ensureOutputDir();
    }

    /**
     * Đảm bảo thư mục output tồn tại
     */
    private ensureOutputDir(): void {
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    /**
     * Khởi tạo tracking với giá trị ban đầu
     */
    public initialize(startTime: number): void {
        this.lastSnapshotTime = startTime;
        this.initialValue = this.calculateTotalValue();

        // Tạo snapshot đầu tiên
        this.captureSnapshot(startTime, true);
    }

    /**
     * Cập nhật snapshot nếu đã đủ thời gian
     */
    public update(currentTime: number): void {
        if (currentTime - this.lastSnapshotTime >= this.snapshotInterval) {
            this.captureSnapshot(currentTime);
            this.lastSnapshotTime = currentTime;
        }
    }

    /**
     * Chụp enhanced snapshot với comprehensive analysis
     */
    private captureSnapshot(timestamp: number, isInitial: boolean = false): void {
        const totals = this.positionManager.getTotals();
        const totalValue = this.calculateTotalValue();
        const tokenAPrice = this.calculateTokenPrice('A');
        const tokenBPrice = this.calculateTokenPrice('B');
        const totalReturn = totalValue - this.initialValue;
        const unrealizedPnL = this.calculateUnrealizedPnL();
        const realizedPnL = this.calculateRealizedPnL(totals);
        const totalFeesUSD = this.calculateTotalFeesUSD(totals);
        const inRangePositions = this.countInRangePositions();
        const outOfRangePositions = totals.positions - inRangePositions;

        const snapshot: VaultSnapshot = {
            timestamp,
            timestampISO: new Date(timestamp).toISOString(),
            totalValueUSD: totalValue,
            cashBalances: {
                tokenA: totals.cashAmountA,
                tokenB: totals.cashAmountB,
                totalUSD: parseFloat(totals.cashAmountA) * tokenAPrice + parseFloat(totals.cashAmountB) * tokenBPrice,
                tokenAPrice,
                tokenBPrice
            },
            positions: {
                count: totals.positions,
                totalLiquidity: this.calculateTotalLiquidity(),
                activePositions: this.countActivePositions(),
                inRangePositions,
                outOfRangePositions,
                avgTickWidth: this.calculateAverageTickWidth()
            },
            fees: {
                collected0: totals.collectedFees0.toString(),
                collected1: totals.collectedFees1.toString(),
                owed0: totals.feesOwed0.toString(),
                owed1: totals.feesOwed1.toString(),
                totalFeesUSD,
                feeYieldAPR: this.calculateFeeYieldAPR(totalFeesUSD, totalValue),
                feeYieldDaily: this.calculateFeeYieldDaily(totalFeesUSD, totalValue)
            },
            performance: {
                totalReturn,
                totalReturnPct: this.initialValue > 0 ? (totalReturn / this.initialValue) * 100 : 0,
                unrealizedPnL,
                unrealizedPnLPct: totalValue > 0 ? (unrealizedPnL / totalValue) * 100 : 0,
                realizedPnL,
                realizedPnLPct: totalValue > 0 ? (realizedPnL / totalValue) * 100 : 0,
                roi: this.calculateROI(totalReturn, this.initialValue),
                sharpeRatio: this.calculateSharpeRatio(),
                maxDrawdown: this.calculateMaxDrawdown(),
                volatility: this.calculateVolatility()
            },
            costs: {
                totalCostTokenA: totals.totalCostTokenA,
                totalCostTokenB: totals.totalCostTokenB,
                totalCostUSD: totals.totalCostTokenA + totals.totalCostTokenB,
                avgCostBasis: this.calculateAverageCostBasis(totals)
            },
            poolState: {
                currentTick: (this.pool as any).currentTick || 0,
                sqrtPriceX64: ((this.pool as any).sqrtPriceX64 || 0n).toString(),
                liquidity: ((this.pool as any).liquidity || 0n).toString(),
                feeGrowthGlobal0X64: ((this.pool as any).feeGrowthGlobal0X64 || 0n).toString(),
                feeGrowthGlobal1X64: ((this.pool as any).feeGrowthGlobal1X64 || 0n).toString(),
                volume24h: this.calculateVolume24h(),
                tvl: this.calculateTVL()
            },
            priceInfo: {
                tokenAPrice,
                tokenBPrice,
                priceRatio: this.calculatePriceRatio(),
                priceChange24h: this.calculatePriceChange24h(),
                volatility24h: this.calculateVolatility24h()
            },
            collateralAnalysis: this.analyzeCollateral(totals),
            investmentOptimization: this.optimizeInvestment(totals),
            riskMetrics: {
                valueAtRisk: this.calculateValueAtRisk(),
                expectedShortfall: this.calculateExpectedShortfall(),
                beta: this.calculateBeta(),
                correlation: this.calculateCorrelation()
            }
        };

        this.snapshots.push(snapshot);

        // Enhanced logging with more metrics
        if (isInitial || this.snapshots.length % 10 === 0) {
            console.log(`📸 Enhanced Vault Snapshot [${snapshot.timestampISO}]:`);
            console.log(`   💰 Value: $${totalValue.toFixed(2)} | Return: ${snapshot.performance.totalReturnPct.toFixed(2)}%`);
            console.log(`   📊 Positions: ${snapshot.positions.count} (${inRangePositions} in-range) | Fees: $${totalFeesUSD.toFixed(2)}`);
            console.log(`   📈 ROI: ${snapshot.performance.roi.toFixed(2)}% | Sharpe: ${snapshot.performance.sharpeRatio.toFixed(2)}`);
        }
    }

    /**
     * Enhanced total value calculation with proper USD conversion
     */
    private calculateTotalValue(): number {
        const totals = this.positionManager.getTotals();
        const tokenAPrice = this.calculateTokenPrice('A');
        const tokenBPrice = this.calculateTokenPrice('B');

        const positionValueA = parseFloat(totals.amountA) * tokenAPrice;
        const positionValueB = parseFloat(totals.amountB) * tokenBPrice;
        const cashValueA = parseFloat(totals.cashAmountA) * tokenAPrice;
        const cashValueB = parseFloat(totals.cashAmountB) * tokenBPrice;
        const feesOwedA = parseFloat(totals.feesOwed0) * tokenAPrice;
        const feesOwedB = parseFloat(totals.feesOwed1) * tokenBPrice;
        const collectedFeesA = parseFloat(totals.collectedFees0) * tokenAPrice;
        const collectedFeesB = parseFloat(totals.collectedFees1) * tokenBPrice;

        return positionValueA + positionValueB + cashValueA + cashValueB +
            feesOwedA + feesOwedB + collectedFeesA + collectedFeesB;
    }

    /**
     * Enhanced total liquidity calculation
     */
    private calculateTotalLiquidity(): string {
        // Sum liquidity from all active positions
        const poolLiquidity = (this.pool as any).liquidity || 0n;
        return poolLiquidity.toString();
    }

    /**
     * Enhanced position counting with detailed analysis
     */
    private countActivePositions(): number {
        // Count positions with liquidity > 0
        // This would need access to individual positions from position manager
        const totals = this.positionManager.getTotals();
        return totals.positions; // Simplified - all positions assumed active
    }

    private countInRangePositions(): number {
        // Count positions that are currently in range
        // This would need access to individual positions and current tick
        const currentTick = (this.pool as any).currentTick || 0;
        // Simplified calculation - would need actual position data
        return Math.floor(this.countActivePositions() * 0.7); // Assume 70% in range
    }

    private calculateAverageTickWidth(): number {
        // Calculate average tick width across all positions
        // This would need access to individual position tick ranges
        return 2000; // Placeholder - typical tick width
    }

    /**
     * Enhanced total fees USD calculation
     */
    private calculateTotalFeesUSD(totals: any): number {
        const collected0USD = parseFloat(totals.collectedFees0.toString()) * this.calculateTokenPrice('A');
        const collected1USD = parseFloat(totals.collectedFees1.toString()) * this.calculateTokenPrice('B');
        const owed0USD = parseFloat(totals.feesOwed0.toString()) * this.calculateTokenPrice('A');
        const owed1USD = parseFloat(totals.feesOwed1.toString()) * this.calculateTokenPrice('B');

        return collected0USD + collected1USD + owed0USD + owed1USD;
    }

    /**
     * Enhanced unrealized PnL calculation
     */
    private calculateUnrealizedPnL(): number {
        const totals = this.positionManager.getTotals();
        const currentValue = parseFloat(totals.amountA) * this.calculateTokenPrice('A') +
            parseFloat(totals.amountB) * this.calculateTokenPrice('B');
        const costBasis = totals.totalCostTokenA + totals.totalCostTokenB;
        return currentValue - costBasis;
    }

    /**
     * Enhanced realized PnL calculation
     */
    private calculateRealizedPnL(totals: any): number {
        const fees0USD = parseFloat(totals.collectedFees0.toString()) * this.calculateTokenPrice('A');
        const fees1USD = parseFloat(totals.collectedFees1.toString()) * this.calculateTokenPrice('B');
        return fees0USD + fees1USD;
    }

    /**
     * Enhanced token price calculation
     */
    private calculateTokenPrice(token: 'A' | 'B'): number {
        const currentTick = (this.pool as any).currentTick || 0;
        const basePrice = Math.pow(1.0001, currentTick);

        if (token === 'A') {
            // Token A (e.g., SUI) - dynamic price from pool
            return basePrice;
        } else {
            // Token B (e.g., USDC) - typically stable
            return 1.0;
        }
    }

    /**
     * Enhanced price ratio and related calculations
     */
    private calculatePriceRatio(): number {
        const priceA = this.calculateTokenPrice('A');
        const priceB = this.calculateTokenPrice('B');
        return priceB > 0 ? priceA / priceB : 0;
    }

    private calculateFeeYieldAPR(totalFeesUSD: number, totalValueUSD: number): number {
        if (totalValueUSD === 0 || this.snapshots.length === 0) return 0;

        const firstSnapshot = this.snapshots[0];
        if (!firstSnapshot) return 0;

        const timeElapsed = Date.now() - firstSnapshot.timestamp;
        const daysElapsed = timeElapsed / (24 * 60 * 60 * 1000);

        if (daysElapsed === 0) return 0;

        const dailyYield = (totalFeesUSD / totalValueUSD) / daysElapsed;
        return dailyYield * 365 * 100; // Convert to APR percentage
    }

    private calculateFeeYieldDaily(totalFeesUSD: number, totalValueUSD: number): number {
        const apr = this.calculateFeeYieldAPR(totalFeesUSD, totalValueUSD);
        return apr / 365;
    }

    private calculateROI(totalReturn: number, initialValue: number): number {
        return initialValue > 0 ? (totalReturn / initialValue) * 100 : 0;
    }

    private calculateSharpeRatio(): number {
        if (this.snapshots.length < 2) return 0;

        const returns = this.snapshots.map((snapshot, index) => {
            if (index === 0) return 0;
            const prevValue = this.snapshots[index - 1]!.totalValueUSD;
            return prevValue > 0 ? (snapshot.totalValueUSD - prevValue) / prevValue : 0;
        }).slice(1);

        if (returns.length === 0) return 0;

        const avgReturn = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
        const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - avgReturn, 2), 0) / returns.length;
        const volatility = Math.sqrt(variance);

        const riskFreeRate = 0.03 / 365; // 3% annual risk-free rate, daily

        return volatility > 0 ? (avgReturn - riskFreeRate) / volatility : 0;
    }

    private calculateMaxDrawdown(): number {
        if (this.snapshots.length < 2) return 0;

        let maxDrawdown = 0;
        let peak = this.snapshots[0]!.totalValueUSD;

        for (const snapshot of this.snapshots) {
            if (snapshot.totalValueUSD > peak) {
                peak = snapshot.totalValueUSD;
            }

            const drawdown = (peak - snapshot.totalValueUSD) / peak;
            if (drawdown > maxDrawdown) {
                maxDrawdown = drawdown;
            }
        }

        return maxDrawdown * 100; // Return as percentage
    }

    private calculateVolatility(): number {
        if (this.snapshots.length < 2) return 0;

        const returns = this.snapshots.map((snapshot, index) => {
            if (index === 0) return 0;
            const prevValue = this.snapshots[index - 1]!.totalValueUSD;
            return prevValue > 0 ? (snapshot.totalValueUSD - prevValue) / prevValue : 0;
        }).slice(1);

        if (returns.length === 0) return 0;

        const avgReturn = returns.reduce((sum, ret) => sum + ret, 0) / returns.length;
        const variance = returns.reduce((sum, ret) => sum + Math.pow(ret - avgReturn, 2), 0) / returns.length;

        return Math.sqrt(variance) * 100; // Return as percentage
    }

    private calculateAverageCostBasis(totals: any): number {
        const totalCost = totals.totalCostTokenA + totals.totalCostTokenB;
        const totalAmount = parseFloat(totals.amountA) + parseFloat(totals.amountB);
        return totalAmount > 0 ? totalCost / totalAmount : 0;
    }

    private calculateVolume24h(): number {
        // Calculate 24h volume - would need historical data
        return 0; // Placeholder
    }

    private calculateTVL(): number {
        const poolLiquidity = Number((this.pool as any).liquidity || 0n);
        const currentPrice = this.calculateTokenPrice('A');
        return poolLiquidity * currentPrice; // Simplified TVL calculation
    }

    private calculatePriceChange24h(): number {
        // Calculate 24h price change - would need historical price data
        if (this.snapshots.length < 2) return 0;

        const current = this.snapshots[this.snapshots.length - 1]!;
        const dayAgo = this.snapshots.find(s =>
            current.timestamp - s.timestamp >= 24 * 60 * 60 * 1000
        );

        if (!dayAgo) return 0;

        const currentPrice = current.priceInfo.tokenAPrice;
        const pastPrice = dayAgo.priceInfo.tokenAPrice;

        return pastPrice > 0 ? ((currentPrice - pastPrice) / pastPrice) * 100 : 0;
    }

    private calculateVolatility24h(): number {
        // Calculate 24h volatility
        const last24hSnapshots = this.snapshots.filter(s =>
            Date.now() - s.timestamp <= 24 * 60 * 60 * 1000
        );

        if (last24hSnapshots.length < 2) return 0;

        const prices = last24hSnapshots.map(s => s.priceInfo.tokenAPrice);
        const avgPrice = prices.reduce((sum, price) => sum + price, 0) / prices.length;
        const variance = prices.reduce((sum, price) => sum + Math.pow(price - avgPrice, 2), 0) / prices.length;

        return Math.sqrt(variance) / avgPrice * 100; // Return as percentage
    }

    /**
     * Lưu snapshots vào file CSV
     */
    public saveSnapshots(filename?: string): void {
        const baseFilename = filename ? filename.replace('.json', '') : `vault_snapshots_${Date.now()}`;
        const csvPath = path.join(this.outputDir, `${baseFilename}.csv`);

        // Save CSV
        this.saveSnapshotsAsCSV(csvPath);
        console.log(`📊 Vault snapshots (CSV) saved to: ${csvPath}`);
    }

    /**
     * Xuất snapshots ra file CSV
     */
    private saveSnapshotsAsCSV(csvPath: string): void {
        if (this.snapshots.length === 0) return;

        const headers = [
            'Timestamp',
            'TimestampISO',
            'TotalValueUSD',
            'CashTokenA',
            'CashTokenB',
            'CashTotalUSD',
            'TokenAPrice',
            'TokenBPrice',
            'PositionCount',
            'ActivePositions',
            'InRangePositions',
            'OutOfRangePositions',
            'TotalLiquidity',
            'AvgTickWidth',
            'CollectedFees0',
            'CollectedFees1',
            'OwedFees0',
            'OwedFees1',
            'TotalFeesUSD',
            'FeeYieldAPR',
            'FeeYieldDaily',
            'TotalReturn',
            'TotalReturnPct',
            'UnrealizedPnL',
            'UnrealizedPnLPct',
            'RealizedPnL',
            'RealizedPnLPct',
            'ROI',
            'SharpeRatio',
            'MaxDrawdown',
            'Volatility',
            'TotalCostTokenA',
            'TotalCostTokenB',
            'TotalCostUSD',
            'AvgCostBasis',
            'CurrentTick',
            'SqrtPriceX64',
            'Liquidity',
            'FeeGrowthGlobal0X64',
            'FeeGrowthGlobal1X64',
            'Volume24h',
            'TVL',
            'PriceRatio',
            'PriceChange24h',
            'Volatility24h',
            'CollateralToken',
            'CollateralAmount',
            'CollateralValueUSD',
            'IsRequirementMet',
            'InvestmentUSD',
            'InvestmentRatio',
            'SwapEfficiency',
            'ValueAtRisk',
            'ExpectedShortfall',
            'Beta',
            'Correlation'
        ];

        const csvRows = [headers.join(',')];

        for (const snapshot of this.snapshots) {
            const row = [
                snapshot.timestamp,
                `"${snapshot.timestampISO}"`,
                snapshot.totalValueUSD,
                `"${snapshot.cashBalances.tokenA}"`,
                `"${snapshot.cashBalances.tokenB}"`,
                snapshot.cashBalances.totalUSD,
                snapshot.cashBalances.tokenAPrice,
                snapshot.cashBalances.tokenBPrice,
                snapshot.positions.count,
                snapshot.positions.activePositions,
                snapshot.positions.inRangePositions,
                snapshot.positions.outOfRangePositions,
                `"${snapshot.positions.totalLiquidity}"`,
                snapshot.positions.avgTickWidth,
                `"${snapshot.fees.collected0}"`,
                `"${snapshot.fees.collected1}"`,
                `"${snapshot.fees.owed0}"`,
                `"${snapshot.fees.owed1}"`,
                snapshot.fees.totalFeesUSD,
                snapshot.fees.feeYieldAPR,
                snapshot.fees.feeYieldDaily,
                snapshot.performance.totalReturn,
                snapshot.performance.totalReturnPct,
                snapshot.performance.unrealizedPnL,
                snapshot.performance.unrealizedPnLPct,
                snapshot.performance.realizedPnL,
                snapshot.performance.realizedPnLPct,
                snapshot.performance.roi,
                snapshot.performance.sharpeRatio,
                snapshot.performance.maxDrawdown,
                snapshot.performance.volatility,
                snapshot.costs.totalCostTokenA,
                snapshot.costs.totalCostTokenB,
                snapshot.costs.totalCostUSD,
                snapshot.costs.avgCostBasis,
                snapshot.poolState.currentTick,
                `"${snapshot.poolState.sqrtPriceX64}"`,
                `"${snapshot.poolState.liquidity}"`,
                `"${snapshot.poolState.feeGrowthGlobal0X64}"`,
                `"${snapshot.poolState.feeGrowthGlobal1X64}"`,
                snapshot.poolState.volume24h,
                snapshot.poolState.tvl,
                snapshot.priceInfo.priceRatio,
                snapshot.priceInfo.priceChange24h,
                snapshot.priceInfo.volatility24h,
                `"${snapshot.collateralAnalysis?.collateralToken || ''}"`,
                snapshot.collateralAnalysis?.collateralAmount || 0,
                snapshot.collateralAnalysis?.collateralValueUSD || 0,
                snapshot.collateralAnalysis?.isRequirementMet || false,
                snapshot.investmentOptimization?.investmentUSD || 0,
                snapshot.investmentOptimization?.investmentRatio || 0,
                snapshot.investmentOptimization?.swapEfficiency || 0,
                snapshot.riskMetrics.valueAtRisk,
                snapshot.riskMetrics.expectedShortfall,
                snapshot.riskMetrics.beta,
                snapshot.riskMetrics.correlation
            ];

            csvRows.push(row.join(','));
        }

        fs.writeFileSync(csvPath, csvRows.join('\n'), 'utf-8');
    }

    /**
     * Generate enhanced summary report with comprehensive metrics
     */
    private generateSummary() {
        if (this.snapshots.length === 0) return null;

        const first = this.snapshots[0]!;
        const last = this.snapshots[this.snapshots.length - 1]!;
        const totalReturn = last.totalValueUSD - first.totalValueUSD;
        const totalReturnPct = first.totalValueUSD > 0 ? (totalReturn / first.totalValueUSD) * 100 : 0;

        return {
            initialValue: first.totalValueUSD,
            finalValue: last.totalValueUSD,
            totalReturn,
            totalReturnPct,
            maxValue: Math.max(...this.snapshots.map(s => s.totalValueUSD)),
            minValue: Math.min(...this.snapshots.map(s => s.totalValueUSD)),
            totalFees: last.fees.totalFeesUSD,
            totalCosts: last.costs.totalCostUSD,
            avgPositions: this.snapshots.reduce((sum, s) => sum + s.positions.count, 0) / this.snapshots.length,
            avgInRangePositions: this.snapshots.reduce((sum, s) => sum + s.positions.inRangePositions, 0) / this.snapshots.length,
            avgInRangePercentage: this.snapshots.reduce((sum, s) =>
                sum + (s.positions.count > 0 ? (s.positions.inRangePositions / s.positions.count) * 100 : 0), 0) / this.snapshots.length,
            performance: {
                roi: last.performance.roi,
                sharpeRatio: last.performance.sharpeRatio,
                maxDrawdown: last.performance.maxDrawdown,
                volatility: last.performance.volatility,
                feeYieldAPR: last.fees.feeYieldAPR,
                avgUnrealizedPnLPct: this.snapshots.reduce((sum, s) => sum + s.performance.unrealizedPnLPct, 0) / this.snapshots.length,
                avgRealizedPnLPct: this.snapshots.reduce((sum, s) => sum + s.performance.realizedPnLPct, 0) / this.snapshots.length
            },
            riskMetrics: {
                valueAtRisk: last.riskMetrics.valueAtRisk,
                expectedShortfall: last.riskMetrics.expectedShortfall,
                beta: last.riskMetrics.beta,
                correlation: last.riskMetrics.correlation
            },
            optimization: {
                totalSwapOpportunities: this.snapshots.filter(s => s.investmentOptimization?.optimalSwaps.length).length,
                avgSwapEfficiency: this.calculateAverageSwapEfficiency(),
                collateralProtectionRate: this.calculateCollateralProtectionRate()
            },
            duration: {
                start: first.timestampISO,
                end: last.timestampISO,
                durationMs: last.timestamp - first.timestamp,
                durationDays: (last.timestamp - first.timestamp) / (24 * 60 * 60 * 1000)
            }
        };
    }

    private calculateAverageSwapEfficiency(): number {
        const swapSnapshots = this.snapshots.filter(s => s.investmentOptimization?.swapEfficiency);
        if (swapSnapshots.length === 0) return 0;

        return swapSnapshots.reduce((sum, s) => sum + s.investmentOptimization!.swapEfficiency, 0) / swapSnapshots.length;
    }

    private calculateCollateralProtectionRate(): number {
        const collateralSnapshots = this.snapshots.filter(s => s.collateralAnalysis?.isRequirementMet);
        return this.snapshots.length > 0 ? (collateralSnapshots.length / this.snapshots.length) * 100 : 0;
    }

    /**
     * Lấy tất cả snapshots
     */
    public getSnapshots(): VaultSnapshot[] {
        return [...this.snapshots];
    }

    /**
     * Lấy snapshot cuối cùng
     */
    public getLatestSnapshot(): VaultSnapshot | null {
        return this.snapshots.length > 0 ? this.snapshots[this.snapshots.length - 1]! : null;
    }

    /**
     * Analyze collateral requirements (inspired by Python vault calculator)
     */
    private analyzeCollateral(totals: any): CollateralAnalysis {
        // This would need actual collateral token and pending redemptions data
        // For now, provide a basic analysis structure
        const collateralToken = 'USDC'; // Placeholder
        const pendingRedemptions = 0; // Would come from vault data
        const collateralAmount = parseFloat(totals.cashAmountB); // Assuming token B is collateral
        const collateralPrice = this.calculateTokenPrice('B');
        const collateralValueUSD = collateralAmount * collateralPrice;
        const pendingRedemptionsUSD = pendingRedemptions * collateralPrice;
        const deficit = Math.max(0, pendingRedemptionsUSD - collateralValueUSD);
        const surplus = Math.max(0, collateralValueUSD - pendingRedemptionsUSD);

        return {
            collateralToken,
            pendingRedemptions,
            collateralAmount,
            collateralValueUSD,
            pendingRedemptionsUSD,
            isRequirementMet: collateralValueUSD >= pendingRedemptionsUSD,
            deficit,
            surplus
        };
    }

    /**
     * Optimize investment allocation (inspired by Python vault calculator)
     */
    private optimizeInvestment(totals: any): InvestmentOptimization {
        const totalValue = this.calculateTotalValue();
        const investmentRatio = 0.5; // 50/50 split
        const investmentUSD = totalValue * 0.8; // Use 80% for investment, 20% for collateral
        const targetTokenAValue = investmentUSD * investmentRatio;
        const targetTokenBValue = investmentUSD * (1 - investmentRatio);

        const currentTokenAValue = parseFloat(totals.amountA) * this.calculateTokenPrice('A');
        const currentTokenBValue = parseFloat(totals.amountB) * this.calculateTokenPrice('B');

        const swaps: SwapPlan[] = [];
        let totalSwapValue = 0;

        // Generate optimal swap plans
        if (currentTokenAValue < targetTokenAValue) {
            const swapAmount = targetTokenAValue - currentTokenAValue;
            swaps.push({
                fromToken: 'tokenB',
                toToken: 'tokenA',
                swapValueUSD: swapAmount,
                swapAmountFrom: swapAmount,
                swapAmountTo: swapAmount / this.calculateTokenPrice('A'),
                reason: 'Rebalance to target allocation',
                routingType: 'optimal',
                efficiency: 0.95
            });
            totalSwapValue += swapAmount;
        } else if (currentTokenBValue < targetTokenBValue) {
            const swapAmount = targetTokenBValue - currentTokenBValue;
            swaps.push({
                fromToken: 'tokenA',
                toToken: 'tokenB',
                swapValueUSD: swapAmount,
                swapAmountFrom: swapAmount / this.calculateTokenPrice('A'),
                swapAmountTo: swapAmount,
                reason: 'Rebalance to target allocation',
                routingType: 'optimal',
                efficiency: 0.95
            });
            totalSwapValue += swapAmount;
        }

        const swapEfficiency = swaps.length > 0 ?
            swaps.reduce((sum, swap) => sum + swap.efficiency, 0) / swaps.length : 1.0;

        return {
            investmentUSD,
            investmentRatio,
            targetTokenAValue,
            targetTokenBValue,
            optimalSwaps: swaps,
            totalSwapValue,
            swapEfficiency,
            avoidedRoundTrips: swaps.every(swap => swap.routingType === 'optimal'),
            collateralProtected: totalValue - investmentUSD
        };
    }

    /**
     * Calculate risk metrics
     */
    private calculateValueAtRisk(): number {
        if (this.snapshots.length < 30) return 0; // Need at least 30 data points

        const returns = this.snapshots.map((snapshot, index) => {
            if (index === 0) return 0;
            const prevValue = this.snapshots[index - 1]!.totalValueUSD;
            return prevValue > 0 ? (snapshot.totalValueUSD - prevValue) / prevValue : 0;
        }).slice(1);

        returns.sort((a, b) => a - b);
        const varIndex = Math.floor(returns.length * 0.05); // 5th percentile
        return returns[varIndex] || 0;
    }

    private calculateExpectedShortfall(): number {
        const var95 = this.calculateValueAtRisk();
        if (this.snapshots.length < 30) return 0;

        const returns = this.snapshots.map((snapshot, index) => {
            if (index === 0) return 0;
            const prevValue = this.snapshots[index - 1]!.totalValueUSD;
            return prevValue > 0 ? (snapshot.totalValueUSD - prevValue) / prevValue : 0;
        }).slice(1);

        const tailReturns = returns.filter(ret => ret <= var95);
        return tailReturns.length > 0 ? tailReturns.reduce((sum, ret) => sum + ret, 0) / tailReturns.length : 0;
    }

    private calculateBeta(): number {
        // Beta calculation would need market benchmark data
        // For now, return a placeholder
        return 1.0;
    }

    private calculateCorrelation(): number {
        // Correlation with market would need benchmark data
        // For now, return a placeholder
        return 0.5;
    }

    /**
     * Xóa tất cả snapshots
     */
    public clearSnapshots(): void {
        this.snapshots = [];
        this.lastSnapshotTime = 0;
    }
}
