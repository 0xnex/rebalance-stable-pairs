import type { IPool, IPositionManager, SwapEvent } from "./types";
import { calculateFundPerformance, calculatePositionsPerformance, exportPerformanceToCSV } from "./performance_exporter";

/**
 * Performance Tracker
 * 
 * Listens to backtest events and captures performance snapshots at regular intervals.
 * Handles all performance metric calculation and CSV export logic.
 */
export class PerformanceTracker {
  private pool: IPool;
  private manager: IPositionManager;
  private initialAmount0: bigint;
  private initialAmount1: bigint;
  private outputDir: string;
  private silent: boolean;
  
  private snapshotIntervalMs: number = 60 * 1000; // 1 minute
  private nextSnapshotTime: number;
  private snapshotCount: number = 0;
  
  constructor(
    pool: IPool,
    manager: IPositionManager,
    initialAmount0: bigint,
    initialAmount1: bigint,
    startTime: number,
    outputDir: string,
    silent: boolean = false
  ) {
    this.pool = pool;
    this.manager = manager;
    this.initialAmount0 = initialAmount0;
    this.initialAmount1 = initialAmount1;
    this.outputDir = outputDir;
    this.silent = silent;
    this.nextSnapshotTime = startTime + this.snapshotIntervalMs;
  }
  
  /**
   * Handle time tick event - capture snapshots if needed
   */
  async onTimeTick(currentTime: number): Promise<void> {
    // Capture all snapshots that should have occurred up to current time
    while (currentTime >= this.nextSnapshotTime) {
      await this.captureSnapshot(this.nextSnapshotTime);
      this.nextSnapshotTime += this.snapshotIntervalMs;
    }
  }
  
  /**
   * Capture a performance snapshot at a specific time
   */
  private async captureSnapshot(timestamp: number): Promise<void> {
    const fundPerf = calculateFundPerformance(
      this.pool,
      this.manager,
      this.initialAmount0,
      this.initialAmount1,
      timestamp
    );
    const posPerfs = calculatePositionsPerformance(this.pool, this.manager, timestamp);
    
    await exportPerformanceToCSV(
      fundPerf,
      posPerfs,
      this.outputDir,
      this.snapshotCount > 0 // append if not first snapshot
    );
    
    this.snapshotCount++;
    
    if (!this.silent && this.snapshotCount % 10 === 0) {
      process.stdout.write(`\r[SNAPSHOT] [performance] [captured] [count=${this.snapshotCount}]${' '.repeat(50)}\n`);
    }
  }
  
  /**
   * Force capture a final snapshot (e.g., at end of backtest)
   */
  async captureFinalSnapshot(endTime: number): Promise<void> {
    // Only capture if we haven't captured recently or if no snapshots at all
    if (endTime > this.nextSnapshotTime - this.snapshotIntervalMs || this.snapshotCount === 0) {
      await this.captureSnapshot(endTime);
    }
  }
  
  /**
   * Get total number of snapshots captured
   */
  getSnapshotCount(): number {
    return this.snapshotCount;
  }
}

