#!/usr/bin/env bun

/**
 * Merge Data - Gộp tất cả data theo thứ tự thời gian
 */

import * as fs from 'fs';
import * as path from 'path';

interface Transaction {
    digest: string;
    timestampMs: string;
    checkpoint: string;
    events: any[];
}

interface DataPage {
    cursor: string;
    nextCursor: string | null;
    data: Transaction[];
}

async function mergeData() {
    console.log('🔄 Merging All Data');
    console.log('===================\n');

    const poolId = '0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9';

    const dataDirs = [
        { dir: `./data_historical/${poolId}`, prefix: 'historical_', label: 'Historical' },
        { dir: `./data_30_days/${poolId}`, prefix: '30day_', label: '30-Day' },
    ];

    const allTransactions: Transaction[] = [];
    let totalFiles = 0;
    let totalEvents = 0;

    // Đọc tất cả data từ các thư mục
    for (const { dir, prefix, label } of dataDirs) {
        if (!fs.existsSync(dir)) {
            console.log(`📁 ${label}: Directory not found - ${dir}`);
            continue;
        }

        const files = fs.readdirSync(dir)
            .filter(f => f.startsWith(prefix))
            .sort();

        if (files.length === 0) {
            console.log(`📁 ${label}: No files found`);
            continue;
        }

        console.log(`📁 ${label}: Processing ${files.length} files...`);

        let processedFiles = 0;
        let skippedFiles = 0;

        for (const file of files) {
            const filePath = path.join(dir, file);

            try {
                const content: DataPage = JSON.parse(fs.readFileSync(filePath, 'utf-8'));

                if (content.data && Array.isArray(content.data)) {
                    allTransactions.push(...content.data);
                    totalEvents += content.data.reduce((sum, tx) => sum + tx.events.length, 0);
                    processedFiles++;
                } else {
                    console.log(`   ⚠️  Skipping ${file}: Invalid data structure`);
                    skippedFiles++;
                }
            } catch (error) {
                console.log(`   ❌ Skipping ${file}: JSON parse error - ${error.message}`);
                skippedFiles++;
                continue;
            }
        }

        totalFiles += processedFiles;
        console.log(`   ✅ Processed: ${processedFiles} files, ⚠️  Skipped: ${skippedFiles} files`);
    }

    console.log(`\n📊 Data Summary:`);
    console.log(`   📁 Total files processed: ${totalFiles}`);
    console.log(`   📄 Total transactions: ${allTransactions.length.toLocaleString()}`);
    console.log(`   📊 Total events: ${totalEvents.toLocaleString()}`);

    if (allTransactions.length === 0) {
        console.log('❌ No data found to merge');
        return;
    }

    // Sắp xếp theo thời gian
    console.log('\n🔄 Sorting by timestamp...');
    allTransactions.sort((a, b) => {
        const timeA = parseInt(a.timestampMs);
        const timeB = parseInt(b.timestampMs);
        return timeA - timeB;
    });

    // Loại bỏ duplicates dựa trên digest
    console.log('🔄 Removing duplicates...');
    const uniqueTransactions = new Map<string, Transaction>();

    for (const tx of allTransactions) {
        if (!uniqueTransactions.has(tx.digest)) {
            uniqueTransactions.set(tx.digest, tx);
        }
    }

    const finalTransactions = Array.from(uniqueTransactions.values());
    const finalEvents = finalTransactions.reduce((sum, tx) => sum + tx.events.length, 0);

    console.log(`📊 After deduplication:`);
    console.log(`   📄 Unique transactions: ${finalTransactions.length.toLocaleString()}`);
    console.log(`   📊 Unique events: ${finalEvents.toLocaleString()}`);
    console.log(`   🗑️  Duplicates removed: ${(allTransactions.length - finalTransactions.length).toLocaleString()}`);

    // Chia thành files với 200 events mỗi file
    console.log('\n💾 Creating merged files...');
    const outputDir = './data_merged';

    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const eventsPerFile = 200;
    let currentBatch: Transaction[] = [];
    let currentEventCount = 0;
    let fileCounter = 1;
    let totalSavedEvents = 0;

    for (const transaction of finalTransactions) {
        const transactionEventCount = transaction.events.length;

        // Nếu thêm transaction này sẽ vượt quá limit, lưu batch hiện tại
        if (currentEventCount + transactionEventCount > eventsPerFile && currentBatch.length > 0) {
            await saveMergedBatch(currentBatch, fileCounter, currentEventCount, outputDir);
            totalSavedEvents += currentEventCount;
            fileCounter++;
            currentBatch = [];
            currentEventCount = 0;
        }

        currentBatch.push(transaction);
        currentEventCount += transactionEventCount;
    }

    // Lưu batch cuối cùng
    if (currentBatch.length > 0) {
        await saveMergedBatch(currentBatch, fileCounter, currentEventCount, outputDir);
        totalSavedEvents += currentEventCount;
    }

    // Thống kê cuối cùng
    const timeRange = {
        start: new Date(parseInt(finalTransactions[0].timestampMs)).toISOString(),
        end: new Date(parseInt(finalTransactions[finalTransactions.length - 1].timestampMs)).toISOString()
    };

    console.log('\n🎉 Merge Complete!');
    console.log('==================');
    console.log(`📁 Output directory: ${outputDir}`);
    console.log(`📄 Merged files: ${fileCounter}`);
    console.log(`📊 Total events: ${totalSavedEvents.toLocaleString()}`);
    console.log(`📅 Time range: ${timeRange.start} to ${timeRange.end}`);
    console.log(`💾 Average events/file: ${(totalSavedEvents / fileCounter).toFixed(0)}`);

    // Tạo metadata file
    const metadata = {
        created: new Date().toISOString(),
        totalFiles: fileCounter,
        totalTransactions: finalTransactions.length,
        totalEvents: totalSavedEvents,
        timeRange,
        sources: dataDirs.map(d => d.label),
        eventsPerFile
    };

    fs.writeFileSync(
        path.join(outputDir, 'metadata.json'),
        JSON.stringify(metadata, null, 2)
    );

    console.log('📋 Metadata saved: ./data_merged/metadata.json');
}

async function saveMergedBatch(transactions: Transaction[], batchNumber: number, eventCount: number, outputDir: string): Promise<void> {
    const fileName = `merged_${String(batchNumber).padStart(5, '0')}.json`;
    const filePath = path.join(outputDir, fileName);

    const page: DataPage = {
        cursor: `merged_${batchNumber}`,
        nextCursor: null,
        data: transactions
    };

    try {
        const jsonContent = JSON.stringify(page, null, 2);
        fs.writeFileSync(filePath, jsonContent, 'utf-8');
        console.log(`   💾 Saved: ${fileName} (${transactions.length} transactions, ${eventCount} events)`);
    } catch (error) {
        console.error(`   ❌ Error saving ${fileName}:`, error);
    }
}

if (import.meta.main) {
    mergeData().catch(console.error);
}
