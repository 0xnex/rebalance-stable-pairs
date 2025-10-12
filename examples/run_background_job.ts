#!/usr/bin/env bun

/**
 * Background Job Runner - Chạy daily fetcher như một background job
 * Có thể chạy liên tục và tự động resume khi bị gián đoạn
 */

import { DailyDataFetcher } from '../daily_data_fetcher';
import { EventType } from '../src/sui_event_fetcher';
import * as fs from 'fs';
import * as path from 'path';

interface JobState {
    lastCompletedDate: string;
    totalDaysProcessed: number;
    totalEvents: number;
    totalTransactions: number;
    startTime: number;
    config: any;
}

class BackgroundJobRunner {
    private stateFile: string;
    private logFile: string;
    private isRunning: boolean = false;

    constructor(private outputDir: string = './daily_data') {
        this.stateFile = path.join(outputDir, 'job_state.json');
        this.logFile = path.join(outputDir, 'job.log');
    }

    /**
     * Chạy job liên tục với auto-resume
     */
    async runContinuous(): Promise<void> {
        console.log('🔄 Starting Background Job Runner');
        console.log('=================================\n');

        // Tạo thư mục output
        if (!fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }

        this.isRunning = true;

        // Setup signal handlers để graceful shutdown
        process.on('SIGINT', () => this.gracefulShutdown('SIGINT'));
        process.on('SIGTERM', () => this.gracefulShutdown('SIGTERM'));

        while (this.isRunning) {
            try {
                await this.runSingleCycle();

                // Nghỉ 1 giờ trước khi chạy cycle tiếp theo
                this.log('💤 Sleeping for 1 hour before next cycle...');
                await this.sleep(60 * 60 * 1000); // 1 hour

            } catch (error) {
                this.log(`❌ Error in cycle: ${error}`);
                this.log('⏳ Waiting 5 minutes before retry...');
                await this.sleep(5 * 60 * 1000); // 5 minutes
            }
        }
    }

    /**
     * Chạy một cycle fetch data
     */
    private async runSingleCycle(): Promise<void> {
        this.log('🚀 Starting new fetch cycle...');

        // Load state từ lần chạy trước (nếu có)
        const state = this.loadState();

        // Tính toán thời gian cần fetch
        const endDate = new Date();
        let startDate: Date;

        if (state && state.lastCompletedDate) {
            // Resume từ ngày cuối cùng đã hoàn thành
            startDate = new Date(state.lastCompletedDate);
            startDate.setDate(startDate.getDate() + 1); // Bắt đầu từ ngày tiếp theo
            this.log(`📅 Resuming from ${startDate.toISOString().split('T')[0]}`);
        } else {
            // Bắt đầu từ 30 ngày trước
            startDate = new Date(endDate.getTime() - 30 * 24 * 60 * 60 * 1000);
            this.log(`📅 Starting fresh from ${startDate.toISOString().split('T')[0]}`);
        }

        // Nếu không có ngày nào để fetch, skip
        if (startDate >= endDate) {
            this.log('✅ All data up to date, no new days to fetch');
            return;
        }

        // Tạo fetcher
        const fetcher = new DailyDataFetcher({
            poolId: '0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9',
            eventTypes: [EventType.Swap, EventType.AddLiquidity, EventType.RemoveLiquidity, EventType.RepayFlashSwap],
            startDate,
            endDate,
            outputDir: this.outputDir,
            batchSize: 100
        });

        // Chạy fetcher
        await fetcher.run();

        // Cập nhật state
        this.saveState({
            lastCompletedDate: endDate.toISOString().split('T')[0],
            totalDaysProcessed: (state?.totalDaysProcessed || 0) + this.calculateDays(startDate, endDate),
            totalEvents: (state?.totalEvents || 0),
            totalTransactions: (state?.totalTransactions || 0),
            startTime: state?.startTime || Date.now(),
            config: {
                poolId: '0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9',
                eventTypes: [EventType.Swap, EventType.AddLiquidity, EventType.RemoveLiquidity, EventType.RepayFlashSwap]
            }
        });

        this.log('✅ Cycle completed successfully');
    }

    /**
     * Load job state từ file
     */
    private loadState(): JobState | null {
        try {
            if (fs.existsSync(this.stateFile)) {
                const data = fs.readFileSync(this.stateFile, 'utf-8');
                return JSON.parse(data);
            }
        } catch (error) {
            this.log(`⚠️ Could not load state: ${error}`);
        }
        return null;
    }

    /**
     * Save job state to file
     */
    private saveState(state: JobState): void {
        try {
            fs.writeFileSync(this.stateFile, JSON.stringify(state, null, 2));
            this.log('💾 State saved successfully');
        } catch (error) {
            this.log(`❌ Could not save state: ${error}`);
        }
    }

    /**
     * Tính số ngày giữa 2 date
     */
    private calculateDays(start: Date, end: Date): number {
        const diffTime = Math.abs(end.getTime() - start.getTime());
        return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    }

    /**
     * Graceful shutdown
     */
    private gracefulShutdown(signal: string): void {
        this.log(`🛑 Received ${signal}, shutting down gracefully...`);
        this.isRunning = false;

        // Cho phép 10 giây để cleanup
        setTimeout(() => {
            this.log('💀 Force exit after timeout');
            process.exit(1);
        }, 10000);
    }

    /**
     * Log với timestamp
     */
    private log(message: string): void {
        const timestamp = new Date().toISOString();
        const logMessage = `[${timestamp}] ${message}`;

        console.log(logMessage);

        // Ghi vào file log
        try {
            fs.appendFileSync(this.logFile, logMessage + '\n');
        } catch (error) {
            console.error('Could not write to log file:', error);
        }
    }

    /**
     * Sleep utility
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get job status
     */
    getStatus(): JobState | null {
        return this.loadState();
    }

    /**
     * Reset job state
     */
    reset(): void {
        if (fs.existsSync(this.stateFile)) {
            fs.unlinkSync(this.stateFile);
            this.log('🔄 Job state reset');
        }
    }
}

// CLI interface
async function main() {
    const argv = Object.fromEntries(
        process.argv.slice(2)
            .map((v, i, a) => v.startsWith('--') ? [v.slice(2), (a[i + 1]?.startsWith('--') || a[i + 1] == null) ? '1' : a[i + 1]] : [])
            .filter(Boolean)
    );

    const outputDir = argv['outputDir'] || './daily_data';
    const runner = new BackgroundJobRunner(outputDir);

    if (argv['status']) {
        // Show status
        const status = runner.getStatus();
        if (status) {
            console.log('📊 Job Status:');
            console.log(`- Last Completed: ${status.lastCompletedDate}`);
            console.log(`- Days Processed: ${status.totalDaysProcessed}`);
            console.log(`- Total Events: ${status.totalEvents}`);
            console.log(`- Total Transactions: ${status.totalTransactions}`);
            console.log(`- Running Since: ${new Date(status.startTime).toISOString()}`);
        } else {
            console.log('📊 No job state found');
        }
        return;
    }

    if (argv['reset']) {
        // Reset state
        runner.reset();
        return;
    }

    // Run continuous job
    await runner.runContinuous();
}

if (import.meta.main) {
    main().catch(console.error);
}

export { BackgroundJobRunner };
