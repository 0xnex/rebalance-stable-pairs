#!/usr/bin/env bun

/**
 * Optimized SUI Event Fetcher - Tối ưu tốc độ tối đa
 * 
 * Strategy:
 * 1. Fetch tất cả events từ RPC trước (parallel)
 * 2. Filter và process trong memory
 * 3. Lưu từng batch 50 events vào JSON files
 * 
 * Usage:
 * bun optimized_fetcher.ts --rpcUrl https://your-rpc-url.com
 */

import { SuiEventFetcher, EventType } from './src/sui_event_fetcher';

// Parse command line arguments
const argv = Object.fromEntries(
    process.argv.slice(2)
        .map((v, i, a) => v.startsWith('--') ? [v.slice(2), (a[i + 1]?.startsWith('--') || a[i + 1] == null) ? '1' : a[i + 1]] : [])
        .filter(Boolean)
);

async function main() {
    console.log('⚡ Optimized SUI Event Fetcher');
    console.log('===============================\n');

    // Validate required RPC URL
    const rpcUrl = argv['rpcUrl'] as string;
    if (!rpcUrl) {
        console.error('❌ RPC URL is required!');
        console.log('Usage: bun optimized_fetcher.ts --rpcUrl https://your-rpc-url.com');
        console.log('\nOptional parameters:');
        console.log('  --poolId         Pool ID to filter (default: all pools)');
        console.log('  --eventTypes     Event types (default: all types)');
        console.log('  --startTime      Start timestamp (default: 0)');
        console.log('  --endTime        End timestamp (default: now)');
        console.log('  --batchSize      RPC batch size (default: 100, min: 100)');
        console.log('  --outputDir      Output directory (default: ./optimized_data)');
        process.exit(1);
    }

    // Parse other parameters
    const poolId = argv['poolId'] as string;
    const startTime = argv['startTime'] ? parseInt(argv['startTime']) : undefined;
    const endTime = argv['endTime'] ? parseInt(argv['endTime']) : undefined;
    const batchSize = argv['batchSize'] ? Math.max(parseInt(argv['batchSize']), 100) : 200; // Minimum 100, default 200
    const outputDir = argv['outputDir'] || './optimized_data';

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
    console.log('🔧 Configuration:');
    console.log(`   📡 RPC URL: ${rpcUrl}`);
    console.log(`   🎯 Pool ID: ${poolId || 'All pools'}`);
    console.log(`   📊 Event Types: ${eventTypes?.join(', ') || 'All types'}`);
    console.log(`   ⏰ Start Time: ${startTime ? new Date(startTime).toISOString() : 'No limit'}`);
    console.log(`   ⏰ End Time: ${endTime ? new Date(endTime).toISOString() : 'No limit'}`);
    console.log(`   📦 RPC Batch Size: ${batchSize} events/request`);
    console.log(`   💾 Output Batch Size: 50 events/file`);
    console.log(`   📁 Output Dir: ${outputDir}\n`);

    // Create optimized fetcher
    const fetcher = new SuiEventFetcher({
        rpcUrl,
        poolId,
        eventTypes,
        startTime,
        endTime,
        batchSize,
        outputDir,
        maxRetries: 5,
        retryDelay: 1000,
        filePrefix: 'optimized_page_'
    });

    const totalStartTime = Date.now();

    try {
        console.log('🚀 Starting optimized fetch process...\n');

        // Run the optimized fetch
        const pages = await fetcher.fetchAllEvents();

        const totalDuration = ((Date.now() - totalStartTime) / 1000).toFixed(2);
        const totalEvents = pages.reduce((sum, page) =>
            sum + page.data.reduce((eventSum, tx) => eventSum + tx.events.length, 0), 0
        );

        console.log('🎉 Optimized Fetch Completed!');
        console.log('=============================');
        console.log(`📄 Total Pages: ${pages.length}`);
        console.log(`📊 Total Events: ${totalEvents.toLocaleString()}`);
        console.log(`⏱️  Total Duration: ${totalDuration}s`);
        console.log(`🚀 Average Speed: ${(totalEvents / parseFloat(totalDuration)).toFixed(0)} events/sec`);
        console.log(`📁 Output Directory: ${outputDir}`);

        if (pages.length > 0) {
            const avgEventsPerPage = (totalEvents / pages.length).toFixed(1);
            console.log(`📈 Average Events/Page: ${avgEventsPerPage}`);
        }

    } catch (error) {
        console.error('\n❌ Error occurred:', error);

        const partialDuration = ((Date.now() - totalStartTime) / 1000).toFixed(2);
        console.log(`\n📊 Partial Statistics (before error):`);
        console.log(`⏱️  Time Elapsed: ${partialDuration}s`);

        process.exit(1);
    }
}

// Performance monitoring
function logMemoryUsage() {
    const used = process.memoryUsage();
    console.log(`💾 Memory Usage:`);
    for (let key in used) {
        console.log(`   ${key}: ${Math.round(used[key as keyof typeof used] / 1024 / 1024 * 100) / 100} MB`);
    }
}

// Example configurations for different scenarios
export const OptimizedConfigs = {
    // Maximum speed configuration
    maxSpeed: {
        batchSize: 500,
        maxRetries: 3,
        retryDelay: 500
    },

    // Balanced configuration
    balanced: {
        batchSize: 200,
        maxRetries: 5,
        retryDelay: 1000
    },

    // Conservative configuration (for unstable networks)
    conservative: {
        batchSize: 100,
        maxRetries: 10,
        retryDelay: 2000
    },

    // Memory optimized (for large datasets)
    memoryOptimized: {
        batchSize: 100,
        maxRetries: 5,
        retryDelay: 1000
    }
};

// Helper function to run with predefined config
export async function runOptimizedFetch(rpcUrl: string, configName: keyof typeof OptimizedConfigs, options: any = {}) {
    const config = OptimizedConfigs[configName];

    console.log(`⚡ Running optimized fetch with ${configName} configuration:`);
    console.log(JSON.stringify(config, null, 2));
    console.log('');

    const fetcher = new SuiEventFetcher({
        rpcUrl,
        ...config,
        ...options
    });

    return await fetcher.fetchAllEvents();
}

// Run main function if this script is executed directly
if (import.meta.main) {
    // Monitor memory usage every 30 seconds
    const memoryMonitor = setInterval(logMemoryUsage, 30000);

    main()
        .then(() => {
            clearInterval(memoryMonitor);
            console.log('\n✅ Process completed successfully!');
        })
        .catch((error) => {
            clearInterval(memoryMonitor);
            console.error('\n❌ Process failed:', error);
            process.exit(1);
        });
}
