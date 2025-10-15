#!/usr/bin/env bun

/**
 * Fetch Data from Database to JSON Files
 * Export raw events from database to JSON files for analysis
 */

import * as fs from 'fs';
import * as path from 'path';
import { rawEventService, RawEvent } from './src/services/raw_event_service.js';

interface ExportParams {
    poolAddress: string;
    outputDir: string;
    eventsPerFile?: number;
    startTime?: number;
    endTime?: number;
    batchSize?: number;
}

interface ExportMetadata {
    created: string;
    poolAddress: string;
    totalFiles: number;
    totalEvents: number;
    timeRange?: {
        start: string;
        end: string;
    };
    eventsPerFile: number;
    batchSize: number;
}

export class DatabaseToJsonExporter {
    private rawEventService = rawEventService;

    /**
     * Export events from database to JSON files
     */
    async exportEvents(params: ExportParams): Promise<void> {
        const {
            poolAddress,
            outputDir,
            eventsPerFile = 200,
            startTime,
            endTime,
            batchSize = 1000
        } = params;

        console.log('🔄 Exporting Data from Database to JSON');
        console.log('========================================\n');

        // Create output directory
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
            console.log(`📁 Created output directory: ${outputDir}`);
        }

        let totalEvents = 0;
        let totalFiles = 0;
        let offset = 0;
        let hasMoreData = true;
        let currentBatch: RawEvent[] = [];
        let currentEventCount = 0;
        let fileCounter = 1;

        const startTimeStr = startTime ? new Date(startTime).toISOString() : 'N/A';
        const endTimeStr = endTime ? new Date(endTime).toISOString() : 'N/A';

        console.log(`📊 Export Parameters:`);
        console.log(`   🏊 Pool Address: ${poolAddress}`);
        console.log(`   📁 Output Directory: ${outputDir}`);
        console.log(`   📄 Events per file: ${eventsPerFile}`);
        console.log(`   📦 Batch size: ${batchSize}`);
        console.log(`   📅 Time range: ${startTimeStr} to ${endTimeStr}\n`);

        try {
            while (hasMoreData) {
                console.log(`🔄 Fetching batch ${Math.floor(offset / batchSize) + 1} (offset: ${offset})...`);

                // Fetch batch from database
                const events = await this.rawEventService.getEvents({
                    poolAddress,
                    limit: batchSize,
                    offset,
                    startTime,
                    endTime
                });

                if (events.length === 0) {
                    hasMoreData = false;
                    console.log('   ✅ No more data to fetch');
                    break;
                }

                console.log(`   📊 Fetched ${events.length} events`);

                // Process each event
                for (const event of events) {
                    // Check if adding this event would exceed the file limit
                    if (currentEventCount >= eventsPerFile && currentBatch.length > 0) {
                        await this.saveBatchToFile(currentBatch, fileCounter, outputDir);
                        totalFiles++;
                        totalEvents += currentEventCount;
                        console.log(`   💾 Saved file ${fileCounter}: ${currentBatch.length} events`);

                        // Reset for next file
                        currentBatch = [];
                        currentEventCount = 0;
                        fileCounter++;
                    }

                    currentBatch.push(event.data);
                    currentEventCount++;
                }

                offset += batchSize;

                // If we got less than batchSize, we've reached the end
                if (events.length < batchSize) {
                    hasMoreData = false;
                }
            }

            // Save the last batch if it has data
            if (currentBatch.length > 0) {
                await this.saveBatchToFile(currentBatch, fileCounter, outputDir);
                totalFiles++;
                totalEvents += currentEventCount;
                console.log(`   💾 Saved final file ${fileCounter}: ${currentBatch.length} events`);
            }

            // Create metadata file
            const metadata: ExportMetadata = {
                created: new Date().toISOString(),
                poolAddress,
                totalFiles,
                totalEvents,
                timeRange: startTime && endTime ? {
                    start: new Date(startTime).toISOString(),
                    end: new Date(endTime).toISOString()
                } : undefined,
                eventsPerFile,
                batchSize
            };

            const metadataPath = path.join(outputDir, 'metadata.json');
            fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

            console.log('\n🎉 Export Complete!');
            console.log('===================');
            console.log(`📁 Output directory: ${outputDir}`);
            console.log(`📄 Total files created: ${totalFiles}`);
            console.log(`📊 Total events exported: ${totalEvents.toLocaleString()}`);
            console.log(`💾 Average events/file: ${totalFiles > 0 ? (totalEvents / totalFiles).toFixed(0) : 0}`);
            console.log(`📋 Metadata saved: ${metadataPath}`);

        } catch (error) {
            console.error('❌ Export failed:', error);
            throw error;
        }
    }

    /**
     * Save a batch of events to a JSON file
     */
    private async saveBatchToFile(events: RawEvent[], fileNumber: number, outputDir: string): Promise<void> {
        const fileName = `export_${String(fileNumber).padStart(5, '0')}.json`;
        const filePath = path.join(outputDir, fileName);

        const fileData = {
            cursor: `export_${fileNumber}`,
            nextCursor: null,
            data: events,
            metadata: {
                fileNumber,
                eventCount: events.length,
                timestamp: new Date().toISOString()
            }
        };

        try {
            const jsonContent = JSON.stringify(fileData, null, 2);
            fs.writeFileSync(filePath, jsonContent, 'utf-8');
        } catch (error) {
            console.error(`❌ Error saving ${fileName}:`, error);
            throw error;
        }
    }

    /**
     * Get statistics about available data in database
     */
    async getDataStats(poolAddress: string, startTime?: number, endTime?: number): Promise<void> {
        console.log('📊 Database Statistics');
        console.log('=====================\n');

        try {
            // Get first batch to check data availability
            const firstBatch = await this.rawEventService.getEvents({
                poolAddress,
                limit: 1,
                offset: 0,
                startTime,
                endTime
            });

            if (firstBatch.length === 0) {
                console.log('❌ No data found for the specified criteria');
                return;
            }

            const firstEvent = firstBatch[0];
            const firstTimestamp = new Date(firstEvent.timestamp_ms).toISOString();

            // Get a larger sample to estimate total
            const sampleBatch = await this.rawEventService.getEvents({
                poolAddress,
                limit: 1000,
                offset: 0,
                startTime,
                endTime
            });

            const lastEvent = sampleBatch[sampleBatch.length - 1];
            const lastTimestamp = new Date(lastEvent.timestamp_ms).toISOString();

            console.log(`🏊 Pool Address: ${poolAddress}`);
            console.log(`📅 Time Range: ${firstTimestamp} to ${lastTimestamp}`);
            console.log(`📊 Sample size: ${sampleBatch.length} events`);
            console.log(`📄 Estimated total events: ${sampleBatch.length >= 1000 ? '1000+' : sampleBatch.length}`);

            if (startTime && endTime) {
                console.log(`🔍 Filtered by time range: ${new Date(startTime).toISOString()} to ${new Date(endTime).toISOString()}`);
            }

        } catch (error) {
            console.error('❌ Error getting statistics:', error);
            throw error;
        }
    }

    /**
     * Close database connection
     */
    async close(): Promise<void> {
        await this.rawEventService.close();
    }
}

// CLI usage
async function main() {
    const args = process.argv.slice(2);

    if (args.length === 0) {
        console.log('Usage: bun fetch_db_to_json.ts <pool_address> [options]');
        console.log('');
        console.log('Options:');
        console.log('  --output-dir <dir>     Output directory (default: ./data_export)');
        console.log('  --events-per-file <n>  Events per file (default: 200)');
        console.log('  --batch-size <n>       Database batch size (default: 1000)');
        console.log('  --start-time <ms>      Start timestamp in milliseconds');
        console.log('  --end-time <ms>        End timestamp in milliseconds');
        console.log('  --stats               Show database statistics only');
        console.log('');
        console.log('Examples:');
        console.log('  bun fetch_db_to_json.ts 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9');
        console.log('  bun fetch_db_to_json.ts 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 --output-dir ./my_data --events-per-file 500');
        console.log('  bun fetch_db_to_json.ts 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 --stats');
        return;
    }

    const poolAddress = args[0];
    const exporter = new DatabaseToJsonExporter();

    try {
        // Parse command line arguments
        const options: any = {
            outputDir: './data_export',
            eventsPerFile: 200,
            batchSize: 1000
        };

        for (let i = 1; i < args.length; i += 2) {
            const key = args[i];
            const value = args[i + 1];

            switch (key) {
                case '--output-dir':
                    options.outputDir = value;
                    break;
                case '--events-per-file':
                    options.eventsPerFile = parseInt(value);
                    break;
                case '--batch-size':
                    options.batchSize = parseInt(value);
                    break;
                case '--start-time':
                    options.startTime = parseInt(value);
                    break;
                case '--end-time':
                    options.endTime = parseInt(value);
                    break;
                case '--stats':
                    await exporter.getDataStats(poolAddress, options.startTime, options.endTime);
                    return;
            }
        }

        // Export data
        await exporter.exportEvents({
            poolAddress,
            ...options
        });

    } catch (error) {
        console.error('❌ Export failed:', error);
        process.exit(1);
    } finally {
        await exporter.close();
    }
}

if (import.meta.main) {
    main().catch(console.error);
}
