#!/usr/bin/env bun

/**
 * Example: Fetch events within a specific time range
 * This script shows how to fetch events between specific timestamps
 */

import { SuiEventFetcher, EventType } from '../src/sui_event_fetcher';

async function fetchTimeRangeEvents() {
    console.log('⏰ Fetching events for specific time range...\n');

    // Time range based on your existing data (around January 2025)
    const startTime = 1756787566000; // Start timestamp from your data
    const endTime = 1756787570000;   // End timestamp from your data

    console.log(`Time range: ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}`);

    const fetcher = new SuiEventFetcher({
        startTime,
        endTime,
        eventTypes: [EventType.Swap], // Only swap events for this example
        batchSize: 100,
        outputDir: './time_range_events',
        filePrefix: 'timerange_'
    });

    try {
        await fetcher.fetchAndSave();
        console.log('\n✅ Time range events fetched successfully!');
    } catch (error) {
        console.error('❌ Error fetching time range events:', error);
    }
}

if (import.meta.main) {
    fetchTimeRangeEvents();
}
