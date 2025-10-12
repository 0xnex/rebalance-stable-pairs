#!/usr/bin/env bun

import { SuiEventFetcher, EventType } from './src/sui_event_fetcher';

/**
 * Example script to fetch SUI events using the SuiEventFetcher
 * 
 * Usage examples:
 * 
 * 1. Fetch all events for a specific pool:
 *    bun fetch_sui_events.ts --poolId 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9
 * 
 * 2. Fetch only swap events:
 *    bun fetch_sui_events.ts --eventTypes Swap
 * 
 * 3. Fetch events in a time range:
 *    bun fetch_sui_events.ts --startTime 1756787566000 --endTime 1756787570000
 * 
 * 4. Use custom RPC endpoint:
 *    bun fetch_sui_events.ts --rpcUrl https://fullnode.mainnet.sui.io:443
 * 
 * 5. Fetch multiple event types:
 *    bun fetch_sui_events.ts --eventTypes Swap,AddLiquidity,RemoveLiquidity
 */

// Parse command line arguments
const argv = Object.fromEntries(
    process.argv.slice(2)
        .map((v, i, a) => v.startsWith('--') ? [v.slice(2), (a[i + 1]?.startsWith('--') || a[i + 1] == null) ? '1' : a[i + 1]] : [])
        .filter(Boolean)
);

async function main() {
    console.log('🚀 SUI Event Fetcher');
    console.log('====================\n');

    // Parse command line arguments
    const poolId = argv['poolId'] as string;
    const rpcUrl = argv['rpcUrl'] as string;
    const startTime = argv['startTime'] ? parseInt(argv['startTime']) : undefined;
    const endTime = argv['endTime'] ? parseInt(argv['endTime']) : undefined;
    const batchSize = argv['batchSize'] ? parseInt(argv['batchSize']) : undefined;
    const outputDir = argv['outputDir'] as string;

    // Parse event types
    let eventTypes: EventType[] | undefined;
    if (argv['eventTypes']) {
        const eventTypeStrings = argv['eventTypes'].split(',');
        eventTypes = eventTypeStrings.map((type: string) => {
            const trimmed = type.trim() as EventType;
            if (!Object.values(EventType).includes(trimmed)) {
                console.error(`❌ Invalid event type: ${trimmed}`);
                console.log(`Valid event types: ${Object.values(EventType).join(', ')}`);
                process.exit(1);
            }
            return trimmed;
        });
    }

    // Display configuration
    console.log('Configuration:');
    console.log(`- Pool ID: ${poolId || 'All pools'}`);
    console.log(`- RPC URL: ${rpcUrl || 'Default mainnet'}`);
    console.log(`- Event Types: ${eventTypes?.join(', ') || 'All types'}`);
    console.log(`- Start Time: ${startTime ? new Date(startTime).toISOString() : 'No limit'}`);
    console.log(`- End Time: ${endTime ? new Date(endTime).toISOString() : 'No limit'}`);
    console.log(`- Batch Size: ${batchSize || 50}`);
    console.log(`- Output Dir: ${outputDir || './mmt_txs'}`);
    console.log('');

    // Create fetcher with configuration
    const fetcher = new SuiEventFetcher({
        poolId,
        rpcUrl,
        eventTypes,
        startTime,
        endTime,
        batchSize,
        outputDir
    });

    try {
        // Fetch and save events
        await fetcher.fetchAndSave();
        console.log('\n✅ Successfully completed fetching and saving events!');
    } catch (error) {
        console.error('\n❌ Error occurred:', error);
        process.exit(1);
    }
}

// Run main function if this script is executed directly
if (import.meta.main) {
    main().catch(console.error);
}
