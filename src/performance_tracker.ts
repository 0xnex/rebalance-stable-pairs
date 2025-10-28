import { Pool } from "./pool";
import { VirtualPositionManager } from "./virtual_position_mgr";

export type PerformanceSample = {
  timestamp: number;
  value: number;
};

export type PerformanceSummary = {
  initialValue: number;
  finalValue: number;
  absoluteReturn: number;
  returnPct: number;
  highestValue: number;
  lowestValue: number;
  maxDrawdownPct: number;
  samples: PerformanceSample[];
};

export class PerformanceTracker {
  private initialValue: number | null = null;
  private finalValue: number | null = null;
  private highestValue = -Infinity;
  private lowestValue = Infinity;
  private peakValue = -Infinity;
  private maxDrawdownPct = 0;
  private lastSampleTs: number | null = null;
  private readonly samples: PerformanceSample[] = [];
  private readonly maxSamples = 10000; // Limit memory usage

  constructor(
    private readonly pool: Pool,
    private readonly manager: VirtualPositionManager,
    private readonly intervalMs: number
  ) {}

  record(timestamp: number, force = false) {
    const value = this.computeValue();
    if (this.initialValue === null) {
      // Use the manager's initial balances as the true initial value
      // (not the computed value which may include positions already created)
      const totals = this.manager.getTotals();
      const initialA = Number(totals.initialAmountA || 0n);
      const initialB = Number(totals.initialAmountB || 0n);
      this.initialValue = initialA * this.pool.price + initialB;
    }
    this.finalValue = value;

    if (value > this.highestValue) this.highestValue = value;
    if (value < this.lowestValue) this.lowestValue = value;

    if (value > this.peakValue) {
      this.peakValue = value;
    } else if (this.peakValue > 0) {
      const drawdown = ((this.peakValue - value) / this.peakValue) * 100;
      if (drawdown > this.maxDrawdownPct) this.maxDrawdownPct = drawdown;
    }

    if (
      force ||
      this.intervalMs <= 0 ||
      this.lastSampleTs === null ||
      timestamp - this.lastSampleTs >= this.intervalMs
    ) {
      this.samples.push({ timestamp, value });
      this.lastSampleTs = timestamp;

      // Keep only most recent samples to limit memory (keep first, last, and recent)
      if (this.samples.length > this.maxSamples) {
        const toKeep = Math.floor(this.maxSamples * 0.8);
        const first = this.samples[0];
        const recent = this.samples.slice(-toKeep);
        this.samples.length = 0;
        if (first) this.samples.push(first);
        this.samples.push(...recent);
      }
    }
  }

  summary(): PerformanceSummary {
    const initialValue = this.initialValue ?? 0;
    const finalValue = this.finalValue ?? initialValue;
    const absoluteReturn = finalValue - initialValue;
    const returnPct =
      initialValue !== 0 ? (absoluteReturn / initialValue) * 100 : 0;

    return {
      initialValue,
      finalValue,
      absoluteReturn,
      returnPct,
      highestValue:
        this.highestValue === -Infinity ? finalValue : this.highestValue,
      lowestValue:
        this.lowestValue === Infinity ? finalValue : this.lowestValue,
      maxDrawdownPct: this.maxDrawdownPct,
      samples: [...this.samples],
    };
  }

  private computeValue(): number {
    const totals = this.manager.getTotals();
    const price = this.pool.price;

    const amountA = Number(totals.amountA ?? 0n);
    const amountB = Number(totals.amountB ?? 0n);
    const cashA = Number(
      (totals as any).cashAmountA ?? totals.initialAmountA ?? 0n
    );
    const cashB = Number(
      (totals as any).cashAmountB ?? totals.initialAmountB ?? 0n
    );
    const feesOwed0 = Number(totals.feesOwed0 ?? 0n);
    const feesOwed1 = Number(totals.feesOwed1 ?? 0n);
    const collectedFees0 = Number((totals as any).collectedFees0 ?? 0n);
    const collectedFees1 = Number((totals as any).collectedFees1 ?? 0n);
    const costA = (totals as any).totalCostTokenA ?? 0;
    const costB = (totals as any).totalCostTokenB ?? 0;

    // Total value = cash + positions + fees (both owed and collected)
    // Note: Collected fees are already in cash after position close
    // So we only add feesOwed (uncollected) to avoid double counting
    const valueTokenB = cashB + amountB + feesOwed1;
    const valueTokenAinB = (cashA + amountA + feesOwed0) * price;
    const costValue = costB + costA * price;
    return valueTokenB + valueTokenAinB - costValue;
  }
}
