#!/usr/bin/env bun

/**
 * Example: Unlimited event fetching with progress tracking
 * This script demonstrates fetching large amounts of data with proper progress tracking
 */

import { SuiEventFetcher, EventType } from '../src/sui_event_fetcher';

async function fetchUnlimitedEvents() {
    console.log('🔄 Starting unlimited event fetching...\n');

    const fetcher = new SuiEventFetcher({
        // No time limits - fetch everything
        eventTypes: [
            EventType.Swap,
            EventType.AddLiquidity,
            EventType.RemoveLiquidity
        ],
        batchSize: 100, // Larger batches for efficiency
        maxRetries: 5,
        retryDelay: 2000, // 2 second delay between retries
        outputDir: './unlimited_events',
        filePrefix: 'unlimited_'
    });

    // Add progress tracking
    let totalPages = 0;
    let totalEvents = 0;
    const startTime = Date.now();

    try {
        console.log('📊 Fetching events with progress tracking...');

        const pages = await fetcher.fetchAllEvents();

        totalPages = pages.length;
        totalEvents = pages.reduce((sum, page) =>
            sum + page.data.reduce((eventSum, tx) => eventSum + tx.events.length, 0), 0
        );

        console.log('\n📈 Fetch Statistics:');
        console.log(`- Total Pages: ${totalPages}`);
        console.log(`- Total Events: ${totalEvents}`);
        console.log(`- Time Elapsed: ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
        console.log(`- Average Events/Page: ${(totalEvents / totalPages).toFixed(2)}`);

        if (pages.length > 0) {
            console.log('\n💾 Saving to files...');
            await fetcher.saveToFiles(pages);
        }

        console.log('\n✅ Unlimited fetch completed successfully!');
    } catch (error) {
        console.error('❌ Error during unlimited fetch:', error);

        const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`\n📊 Partial Statistics (before error):`);
        console.log(`- Pages Processed: ${totalPages}`);
        console.log(`- Events Processed: ${totalEvents}`);
        console.log(`- Time Elapsed: ${elapsed}s`);
    }
}

if (import.meta.main) {
    fetchUnlimitedEvents();
}
