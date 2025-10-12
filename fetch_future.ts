#!/usr/bin/env bun

/**
 * Fetch Future Data - Lấy data mới từ sau data hiện tại đến hiện tại
 */

import { SuiEventFetcher, EventType } from './src/sui_event_fetcher';
import * as fs from 'fs';
import * as path from 'path';

async function fetchFuture() {
    console.log('🔮 Fetching Future Data');
    console.log('=======================\n');

    const poolId = '0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9';

    // Tìm timestamp mới nhất từ data đã có
    const existingDataDir = './data_30_days';
    let newestTimestamp = 0;

    console.log('🔍 Analyzing existing data...');

    if (fs.existsSync(existingDataDir)) {
        const files = fs.readdirSync(existingDataDir)
            .filter(f => f.startsWith('30day_'))
            .sort()
            .reverse(); // Sort descending để lấy file mới nhất

        if (files.length > 0) {
            console.log(`📁 Found ${files.length} existing files`);

            // Đọc file cuối cùng để tìm timestamp mới nhất
            const lastFile = path.join(existingDataDir, files[0]);
            const lastContent = JSON.parse(fs.readFileSync(lastFile, 'utf-8'));

            if (lastContent.data && lastContent.data.length > 0) {
                // Tìm timestamp lớn nhất trong file cuối cùng
                const timestamps = lastContent.data.map((tx: any) => parseInt(tx.timestampMs));
                newestTimestamp = Math.max(...timestamps);

                console.log(`📅 Newest existing data: ${new Date(newestTimestamp).toISOString()}`);
            }
        } else {
            console.log('📁 No existing data found');
            return;
        }
    } else {
        console.log('📁 No existing data directory found');
        return;
    }

    const now = Date.now();
    const futureStartTime = newestTimestamp + (60 * 1000); // Thêm 1 phút để tránh overlap

    console.log('\n🔮 Future Collection Config:');
    console.log(`   📅 Start: ${new Date(futureStartTime).toISOString()} (After existing data)`);
    console.log(`   📅 End: ${new Date(now).toISOString()} (Now)`);
    console.log(`   🎯 Pool: ${poolId}`);
    console.log(`   📊 Events: All event types`);
    console.log(`   📦 Batch: 1000 events/request`);
    console.log(`   📁 Files: 200 events/file`);
    console.log('');

    if (futureStartTime >= now) {
        console.log('✅ No new data needed - existing data is up to date');
        return;
    }

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
        startTime: futureStartTime,
        endTime: now,
        batchSize: 1000,
        outputDir: './data_future',
        filePrefix: 'future_'
    });

    const startTime = Date.now();

    try {
        console.log('🚀 Starting future data collection...');
        console.log('⚠️  This should be relatively quick. Progress will be logged.\n');

        const pages = await fetcher.fetchAllEvents();

        const duration = (Date.now() - startTime) / 1000;

        // Count results
        const outputDir = './data_future';
        let fileCount = 0;
        let totalEvents = 0;
        let totalSize = 0;

        if (fs.existsSync(outputDir)) {
            const files = fs.readdirSync(outputDir).filter((f: string) => f.startsWith('future_'));
            fileCount = files.length;

            for (const file of files) {
                const filePath = `${outputDir}/${file}`;
                const stats = fs.statSync(filePath);
                totalSize += stats.size;

                const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                totalEvents += content.data.reduce((sum: number, tx: any) => sum + tx.events.length, 0);
            }
        }

        console.log('\n🎉 Future Data Collection Complete!');
        console.log('===================================');
        console.log(`⏱️  Total Duration: ${duration.toFixed(1)} seconds`);
        console.log(`📊 Total Events: ${totalEvents.toLocaleString()}`);
        console.log(`📁 Total Files: ${fileCount.toLocaleString()}`);
        console.log(`💾 Total Size: ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
        console.log(`🚀 Average Speed: ${(totalEvents / duration).toFixed(0)} events/sec`);
        console.log(`📁 Output Directory: ${outputDir}`);

        // Instructions
        console.log('\n📋 Data Status:');
        console.log('===============');
        console.log('✅ Historical: ./data_historical/ (if exists)');
        console.log('✅ Main: ./data_30_days/');
        console.log('✅ Future: ./data_future/');
        console.log('💡 Run merge script to combine all data chronologically');

    } catch (error) {
        const partialDuration = (Date.now() - startTime) / 1000;
        console.error('\n❌ Future collection failed:', error);
        console.log(`⏱️  Partial duration: ${partialDuration.toFixed(1)} seconds`);
    }
}

if (import.meta.main) {
    fetchFuture().catch(console.error);
}
