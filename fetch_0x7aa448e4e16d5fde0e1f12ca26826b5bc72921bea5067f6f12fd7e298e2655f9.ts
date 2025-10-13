#!/usr/bin/env bun

/**
 * Fetch Data - Optimized command for collection
 */

import { SuiEventFetcher, EventType } from './src/sui_event_fetcher';

async function fetch30Days() {
    console.log('📅 Fetching Data');
    console.log('========================\n');

    const poolId = '0x7aa448e4e16d5fde0e1f12ca26826b5bc72921bea5067f6f12fd7e298e2655f9';

    // ngày từ hiện tại
    const now = Date.now();
    const thirtyDaysAgo = now - (365 * 24 * 60 * 60 * 1000);

    console.log('📅 Collection Config:');
    console.log(`   📅 Start: ${new Date(thirtyDaysAgo).toISOString()}`);
    console.log(`   📅 End: ${new Date(now).toISOString()}`);
    console.log(`   🎯 Pool: ${poolId}`);
    console.log(`   📊 Events: Swap + AddLiquidity + RemoveLiquidity + RepayFlashSwap + CreatePool + OpenPosition`);
    console.log(`   📦 Batch: 1000 events/request (optimized)`);
    console.log(`   📁 Files: 200 events/file`);
    console.log(`   ⚡ Delay: 10ms (fast)`);
    console.log('');

    const fetcher = new SuiEventFetcher({
        rpcUrl: 'https://fullnode.mainnet.sui.io:443',
        poolId: poolId,
        eventTypes: [
            EventType.Swap,
            EventType.AddLiquidity,
            EventType.RemoveLiquidity,
            EventType.RepayFlashSwap,
            EventType.CreatePool,
            EventType.OpenPosition
        ],
        startTime: thirtyDaysAgo,
        endTime: now,
        batchSize: 1000,
        outputDir: `./data/${poolId}`,
        filePrefix: `data_${poolId}_`
    });

    const startTime = Date.now();

    try {
        console.log('🚀 Starting collection...');
        console.log('⚠️  This will take several hours. Progress will be logged.\n');

        const pages = await fetcher.fetchAllEvents();

        const duration = (Date.now() - startTime) / 1000;

        // Count results
        const fs = require('fs');
        const outputDir = `./data/${poolId}`;
        let fileCount = 0;
        let totalEvents = 0;
        let totalSize = 0;

        if (fs.existsSync(outputDir)) {
            const files = fs.readdirSync(outputDir).filter((f: string) => f.startsWith(`data_${poolId}_`));
            fileCount = files.length;

            for (const file of files) {
                const filePath = `${outputDir}/${file}`;
                const stats = fs.statSync(filePath);
                totalSize += stats.size;

                const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                totalEvents += content.data.reduce((sum: number, tx: any) => sum + tx.events.length, 0);
            }
        }

        console.log('\n🎉 Collection Complete!');
        console.log('==============================');
        console.log(`⏱️  Total Duration: ${(duration / 3600).toFixed(1)} hours`);
        console.log(`📊 Total Events: ${totalEvents.toLocaleString()}`);
        console.log(`📁 Total Files: ${fileCount.toLocaleString()}`);
        console.log(`💾 Total Size: ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB`);
        console.log(`🚀 Average Speed: ${(totalEvents / duration).toFixed(0)} events/sec`);
        console.log(`📁 Output Directory: ${outputDir}`);

        // Performance summary
        console.log('\n📈 Performance Summary:');
        console.log('======================');
        console.log(`📊 Events/hour: ${((totalEvents / duration) * 3600).toLocaleString()}`);
        console.log(`📁 Files/hour: ${((fileCount / duration) * 3600).toFixed(0)}`);
        console.log(`💾 GB/hour: ${((totalSize / 1024 / 1024 / 1024 / duration) * 3600).toFixed(2)}`);

        if (totalEvents > 0) {
            console.log(`📈 Average events/file: ${(totalEvents / fileCount).toFixed(0)}`);
            console.log(`📈 Average file size: ${(totalSize / fileCount / 1024).toFixed(1)} KB`);
        }

    } catch (error) {
        const partialDuration = (Date.now() - startTime) / 1000;
        console.error('\n❌ Collection failed:', error);
        console.log(`⏱️  Partial duration: ${(partialDuration / 3600).toFixed(1)} hours`);

        // Check partial results
        const fs = require('fs');
        const outputDir = `./data/${poolId}`;
        if (fs.existsSync(outputDir)) {
            const files = fs.readdirSync(outputDir).filter((f: string) => f.startsWith(`data_${poolId}_`));
            console.log(`📁 Partial files saved: ${files.length}`);
            console.log('💡 You can resume collection or use partial data');
        }
    }
}

if (import.meta.main) {
    fetch30Days().catch(console.error);
}
