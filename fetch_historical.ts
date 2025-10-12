#!/usr/bin/env bun

/**
 * Fetch Historical Data - Lấy data từ khi pool được khởi tạo đến data hiện tại
 */

import { SuiEventFetcher, EventType } from './src/sui_event_fetcher';
import * as fs from 'fs';
import * as path from 'path';

async function fetchHistorical() {
    console.log('📜 Fetching Historical Data');
    console.log('===========================\n');

    const poolId = '0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9';

    // Tìm timestamp cũ nhất từ data đã có
    const existingDataDir = './data_30_days';
    // let oldestTimestamp = Date(1757667157490);

    // console.log('🔍 Analyzing existing data...');

    // if (fs.existsSync(existingDataDir)) {
    //     const files = fs.readdirSync(existingDataDir)
    //         .filter(f => f.startsWith('30day_'))
    //         .sort();

    //     if (files.length > 0) {
    //         console.log(`📁 Found ${files.length} existing files`);

    //         // Đọc file cuối cùng để tìm timestamp cũ nhất
    //         const firstFile = path.join(existingDataDir, files[files.length - 1]);
    //         const firstContent = JSON.parse(fs.readFileSync(firstFile, 'utf-8'));

    //         if (firstContent.data && firstContent.data.length > 0) {
    //             // Tìm timestamp nhỏ nhất trong file cuối cùng
    //             const timestamps = firstContent.data.map((tx: any) => parseInt(tx.timestampMs));
    //             oldestTimestamp = Math.min(...timestamps);

    //             console.log(`📅 Oldest existing data: ${new Date(oldestTimestamp).toISOString()}`);
    //         }
    //     } else {
    //         console.log('📁 No existing data found, will fetch from pool creation');
    //     }
    // } else {
    //     console.log('📁 No existing data directory found');
    // }

    // Pool creation time (ước tính - có thể điều chỉnh)
    // Thường pools được tạo vài tháng trước
    const poolCreationTime = new Date('2024-01-01').getTime(); // Điều chỉnh theo pool thực tế
    const historicalEndTime = 1757667157490// Lùi 1 phút để tránh overlap

    console.log('\n📜 Historical Collection Config:');
    console.log(`   📅 Start: ${new Date(poolCreationTime).toISOString()} (Pool creation)`);
    console.log(`   📅 End: ${new Date(historicalEndTime).toISOString()} (Before existing data)`);
    console.log(`   🎯 Pool: ${poolId}`);
    console.log(`   📊 Events: All event types`);
    console.log(`   📦 Batch: 1000 events/request`);
    console.log(`   📁 Files: 200 events/file`);
    console.log('');

    if (historicalEndTime <= poolCreationTime) {
        console.log('✅ No historical data needed - existing data covers from pool creation');
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
        startTime: poolCreationTime,
        endTime: historicalEndTime,
        batchSize: 1000,
        outputDir: './data_historical',
        filePrefix: 'historical_'
    });

    const startTime = Date.now();

    try {
        console.log('🚀 Starting historical collection...');
        console.log('⚠️  This may take many hours for full history. Progress will be logged.\n');

        const pages = await fetcher.fetchAllEvents();

        const duration = (Date.now() - startTime) / 1000;

        // Count results
        const outputDir = './data_historical';
        let fileCount = 0;
        let totalEvents = 0;
        let totalSize = 0;

        if (fs.existsSync(outputDir)) {
            const files = fs.readdirSync(outputDir).filter((f: string) => f.startsWith('historical_'));
            fileCount = files.length;

            for (const file of files) {
                const filePath = `${outputDir}/${file}`;
                const stats = fs.statSync(filePath);
                totalSize += stats.size;

                const content = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
                totalEvents += content.data.reduce((sum: number, tx: any) => sum + tx.events.length, 0);
            }
        }

        console.log('\n🎉 Historical Collection Complete!');
        console.log('==================================');
        console.log(`⏱️  Total Duration: ${(duration / 3600).toFixed(1)} hours`);
        console.log(`📊 Total Events: ${totalEvents.toLocaleString()}`);
        console.log(`📁 Total Files: ${fileCount.toLocaleString()}`);
        console.log(`💾 Total Size: ${(totalSize / 1024 / 1024 / 1024).toFixed(2)} GB`);
        console.log(`🚀 Average Speed: ${(totalEvents / duration).toFixed(0)} events/sec`);
        console.log(`📁 Output Directory: ${outputDir}`);

        // Merge instructions
        console.log('\n📋 Next Steps:');
        console.log('==============');
        console.log('1. Historical data saved in: ./data_historical/');
        console.log('2. Existing data in: ./data_30_days/');
        console.log('3. Run merge script to combine chronologically');
        console.log('4. Use fetch_future.ts to get new data going forward');

    } catch (error) {
        const partialDuration = (Date.now() - startTime) / 1000;
        console.error('\n❌ Historical collection failed:', error);
        console.log(`⏱️  Partial duration: ${(partialDuration / 3600).toFixed(1)} hours`);

        // Check partial results
        const outputDir = './data_historical';
        if (fs.existsSync(outputDir)) {
            const files = fs.readdirSync(outputDir).filter((f: string) => f.startsWith('historical_'));
            console.log(`📁 Partial files saved: ${files.length}`);
            console.log('💡 You can resume collection or use partial data');
        }
    }
}

if (import.meta.main) {
    fetchHistorical().catch(console.error);
}
