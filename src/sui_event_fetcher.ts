import { SuiClient, getFullnodeUrl } from '@mysten/sui.js/client';
import type { SuiEvent, PaginatedEvents, EventId } from '@mysten/sui.js/client';
import * as fs from 'fs';
import * as path from 'path';

// Event types for the momentum protocol
export enum EventType {
    Swap = 'SwapEvent',
    AddLiquidity = 'AddLiquidityEvent',
    RemoveLiquidity = 'RemoveLiquidityEvent',
    RepayFlashSwap = 'RepayFlashSwapEvent',
    CreatePool = 'PoolCreatedEvent',
    OpenPosition = 'OpenPositionEvent'
}

export const EventTypes: Record<EventType, string> = {
    [EventType.Swap]: '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::trade::SwapEvent',
    [EventType.AddLiquidity]: '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::liquidity::AddLiquidityEvent',
    [EventType.RemoveLiquidity]: '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::liquidity::RemoveLiquidityEvent',
    [EventType.RepayFlashSwap]: '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::trade::RepayFlashSwapEvent',
    [EventType.CreatePool]: '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::create_pool::PoolCreatedEvent',
    [EventType.OpenPosition]: '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::liquidity::OpenPositionEvent'
};

// Data structures matching the existing JSON format
export interface MomentumEvent {
    id: {
        txDigest: string;
        eventSeq: string;
    };
    packageId: string;
    transactionModule: string;
    sender: string;
    type: string;
    parsedJson: any;
    bcsEncoding: string;
    bcs: string;
}

export interface MomentumTransaction {
    digest: string;
    timestampMs: string;
    checkpoint: string;
    events: MomentumEvent[];
}

export interface MomentumEventPage {
    cursor: string;
    nextCursor: string | null;
    data: MomentumTransaction[];
}

export interface SuiEventFetcherConfig {
    rpcUrl?: string;
    poolId?: string;
    eventTypes?: EventType[];
    startTime?: number;
    endTime?: number;
    batchSize?: number;
    maxRetries?: number;
    retryDelay?: number;
    outputDir?: string;
    filePrefix?: string;
}

export class SuiEventFetcher {
    private client: SuiClient;
    private config: Required<SuiEventFetcherConfig>;

    constructor(config: SuiEventFetcherConfig = {}) {
        this.config = {
            rpcUrl: config.rpcUrl || 'https://fullnode.mainnet.sui.io:443',
            poolId: config.poolId || '',
            eventTypes: config.eventTypes || Object.values(EventType),
            startTime: config.startTime || 0,
            endTime: config.endTime || Date.now(),
            batchSize: config.batchSize || 1000, // Optimized: doubled batch size
            maxRetries: config.maxRetries || 5,
            retryDelay: config.retryDelay || 1000,
            outputDir: config.outputDir || './mmt_txs',
            filePrefix: config.filePrefix || 'page_'
        };

        this.client = new SuiClient({ url: this.config.rpcUrl });
    }

    /**
     * Fetch all events with streaming strategy: fetch and save immediately without caching
     */
    async fetchAllEvents(): Promise<MomentumEventPage[]> {
        console.log(`🚀 Starting streaming fetch from SUI RPC...`);
        console.log(`📡 RPC URL: ${this.config.rpcUrl}`);
        console.log(`🎯 Pool ID: ${this.config.poolId || 'All pools'}`);
        console.log(`📊 Event types: ${this.config.eventTypes.join(', ')}`);
        console.log(`⏰ Time range: ${new Date(this.config.startTime).toISOString()} to ${new Date(this.config.endTime).toISOString()}`);
        console.log(`📦 Batch size: ${this.config.batchSize} events per request\n`);

        // Create output directory
        const outputDir = this.config.poolId
            ? path.join(this.config.outputDir, this.config.poolId)
            : this.config.outputDir;

        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        // Stream fetch and save immediately
        const pages = await this.streamFetchAndSave(outputDir);

        console.log(`\n✅ Completed streaming fetch. Total: ${pages.length} pages`);
        return pages;
    }

    /**
     * Stream fetch and save immediately without caching in memory
     */
    private async streamFetchAndSave(outputDir: string): Promise<MomentumEventPage[]> {
        console.log(`📥 Starting streaming fetch and save...`);

        const pages: MomentumEventPage[] = [];
        let totalEvents = 0;
        let fileCounter = 1;
        const startTime = Date.now();

        // Current batch for accumulating events
        let currentBatch: MomentumTransaction[] = [];
        let currentEventCount = 0;
        const eventsPerFile = 200; // Optimized: 4x more events per file

        // Fetch all event types in parallel
        const fetchPromises = this.config.eventTypes.map(async (eventType) => {
            const eventTypeString = EventTypes[eventType];
            console.log(`   🔄 Starting stream for ${eventType}...`);

            let cursor: EventId | null = null;
            let hasNextPage = true;
            let pageCount = 0;
            let eventTypeTotal = 0;

            while (hasNextPage) {
                try {
                    const result = await this.fetchEventPageOptimized(eventTypeString, cursor);

                    if (result && result.data.length > 0) {
                        // Process events immediately without storing in memory
                        const filteredTransactions = this.filterTransactions(result.data);

                        // Add to current batch and save when full
                        for (const transaction of filteredTransactions) {
                            const transactionEventCount = transaction.events.length;

                            // If adding this transaction would exceed limit, save current batch
                            if (currentEventCount + transactionEventCount > eventsPerFile && currentBatch.length > 0) {
                                await this.saveStreamBatch(currentBatch, fileCounter, currentEventCount, outputDir);

                                const page: MomentumEventPage = {
                                    cursor: `stream_${fileCounter}`,
                                    nextCursor: null,
                                    data: []  // Don't store in memory
                                };
                                pages.push(page);

                                totalEvents += currentEventCount;
                                fileCounter++;
                                currentBatch = [];
                                currentEventCount = 0;
                            }

                            currentBatch.push(transaction);
                            currentEventCount += transactionEventCount;
                        }

                        pageCount++;
                        eventTypeTotal += result.data.length;

                        // Log progress every 20 pages
                        if (pageCount % 20 === 0) {
                            console.log(`   📄 ${eventType}: ${pageCount} pages, ${eventTypeTotal} raw events processed`);
                        }
                    }

                    cursor = result?.nextCursor || null;
                    hasNextPage = !!cursor;

                    // Optimized delay for maximum speed
                    if (hasNextPage) {
                        await this.sleep(10); // Optimized: reduced to 10ms
                    }

                } catch (error) {
                    console.error(`❌ Error streaming ${eventType}:`, error);
                    await this.handleRetry(eventType, cursor);
                    break;
                }
            }

            console.log(`   ✅ ${eventType}: ${eventTypeTotal} raw events processed`);
        });

        // Wait for all event types to complete
        await Promise.all(fetchPromises);

        // Save remaining batch
        if (currentBatch.length > 0) {
            await this.saveStreamBatch(currentBatch, fileCounter, currentEventCount, outputDir);

            const page: MomentumEventPage = {
                cursor: `stream_${fileCounter}`,
                nextCursor: null,
                data: []
            };
            pages.push(page);

            totalEvents += currentEventCount;
        }

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        console.log(`   📊 Total events saved: ${totalEvents.toLocaleString()}`);
        console.log(`   📁 Total files created: ${fileCounter}`);
        console.log(`   ⏱️  Stream duration: ${duration}s`);
        console.log(`   🚀 Speed: ${(totalEvents / parseFloat(duration)).toFixed(0)} events/sec\n`);

        return pages;
    }

    /**
     * Step 2: Filter and process all events in memory
     */
    private filterAndProcessEvents(events: SuiEvent[]): MomentumTransaction[] {
        console.log(`🔍 Step 2: Filtering and processing ${events.length.toLocaleString()} events...`);

        const startTime = Date.now();
        let filteredCount = 0;
        let processedCount = 0;

        // Sort events by timestamp for better performance
        events.sort((a, b) => {
            const timeA = parseInt(a.timestampMs || '0');
            const timeB = parseInt(b.timestampMs || '0');
            return timeA - timeB;
        });

        const transactionMap = new Map<string, {
            digest: string;
            timestampMs: string;
            checkpoint: string;
            events: MomentumEvent[];
        }>();

        for (const event of events) {
            processedCount++;

            // Progress logging every 10k events
            if (processedCount % 10000 === 0) {
                console.log(`   📊 Processed: ${processedCount.toLocaleString()}/${events.length.toLocaleString()} events`);
            }

            const txDigest = event.id.txDigest;
            const timestampMs = event.timestampMs || '0';
            const timestamp = parseInt(timestampMs);

            // Filter by time range
            if (timestamp < this.config.startTime || timestamp > this.config.endTime) {
                continue;
            }

            // Filter by pool ID if specified
            if (this.config.poolId && event.parsedJson &&
                typeof event.parsedJson === 'object' &&
                'pool_id' in event.parsedJson &&
                event.parsedJson.pool_id !== this.config.poolId) {
                continue;
            }

            filteredCount++;

            if (!transactionMap.has(txDigest)) {
                transactionMap.set(txDigest, {
                    digest: txDigest,
                    timestampMs,
                    checkpoint: (event as any).checkpoint?.toString() || '0',
                    events: []
                });
            }

            const transaction = transactionMap.get(txDigest)!;

            // Convert SuiEvent to MomentumEvent format
            const momentumEvent: MomentumEvent = {
                id: {
                    txDigest: event.id.txDigest,
                    eventSeq: event.id.eventSeq.toString()
                },
                packageId: event.packageId,
                transactionModule: event.transactionModule,
                sender: event.sender,
                type: event.type,
                parsedJson: event.parsedJson,
                bcsEncoding: 'base64',
                bcs: event.bcs || ''
            };

            transaction.events.push(momentumEvent);
        }

        const transactions = Array.from(transactionMap.values());
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        console.log(`   ✅ Filtered: ${filteredCount.toLocaleString()}/${events.length.toLocaleString()} events`);
        console.log(`   📄 Transactions: ${transactions.length.toLocaleString()}`);
        console.log(`   ⏱️  Processing duration: ${duration}s\n`);

        return transactions;
    }

    /**
     * Step 3: Create batches of 50 events and save incrementally
     */
    private async createBatchesAndSave(transactions: MomentumTransaction[]): Promise<MomentumEventPage[]> {
        console.log(`💾 Step 3: Creating batches and saving to files...`);

        const pages: MomentumEventPage[] = [];
        const eventsPerBatch = 50;
        let currentBatch: MomentumTransaction[] = [];
        let currentEventCount = 0;
        let batchNumber = 1;
        let totalEventsSaved = 0;

        for (const transaction of transactions) {
            const transactionEventCount = transaction.events.length;

            // If adding this transaction would exceed 50 events, save current batch
            if (currentEventCount + transactionEventCount > eventsPerBatch && currentBatch.length > 0) {
                await this.saveBatch(currentBatch, batchNumber, currentEventCount);

                const page: MomentumEventPage = {
                    cursor: `batch_${batchNumber}`,
                    nextCursor: batchNumber < Math.ceil(transactions.length / 10) ? `batch_${batchNumber + 1}` : null,
                    data: [...currentBatch]
                };
                pages.push(page);

                totalEventsSaved += currentEventCount;
                batchNumber++;
                currentBatch = [];
                currentEventCount = 0;
            }

            currentBatch.push(transaction);
            currentEventCount += transactionEventCount;
        }

        // Save remaining batch
        if (currentBatch.length > 0) {
            await this.saveBatch(currentBatch, batchNumber, currentEventCount);

            const page: MomentumEventPage = {
                cursor: `batch_${batchNumber}`,
                nextCursor: null,
                data: [...currentBatch]
            };
            pages.push(page);

            totalEventsSaved += currentEventCount;
        }

        console.log(`   ✅ Saved ${pages.length} batches with ${totalEventsSaved.toLocaleString()} total events\n`);
        return pages;
    }

    /**
     * Optimized RPC call with larger batch size
     */
    private async fetchEventPageOptimized(eventType: string, cursor: EventId | null): Promise<PaginatedEvents | null> {
        const query = {
            MoveEventType: eventType
        };

        const options = {
            cursor,
            limit: this.config.batchSize, // Use configured batch size directly
            descending: false
        };

        const result = await this.client.queryEvents({
            query,
            ...options
        });

        return result;
    }

    /**
     * Save a batch immediately to file (streaming approach)
     */
    private async saveStreamBatch(transactions: MomentumTransaction[], batchNumber: number, eventCount: number, outputDir: string): Promise<void> {
        const fileName = `${this.config.filePrefix}${String(batchNumber).padStart(5, '0')}.json`;
        const filePath = path.join(outputDir, fileName);

        const page: MomentumEventPage = {
            cursor: `stream_${batchNumber}`,
            nextCursor: null,
            data: transactions
        };

        try {
            const jsonContent = JSON.stringify(page, null, 2); // Reduced indentation for smaller files
            fs.writeFileSync(filePath, jsonContent, 'utf-8');
            console.log(`   💾 Saved: ${fileName} (${transactions.length} transactions, ${eventCount} events)`);
        } catch (error) {
            console.error(`   ❌ Error saving ${fileName}:`, error);
        }
    }

    /**
     * Save a single batch to file immediately
     */
    private async saveBatch(transactions: MomentumTransaction[], batchNumber: number, eventCount: number): Promise<void> {
        const outputDir = this.config.poolId
            ? path.join(this.config.outputDir, this.config.poolId)
            : this.config.outputDir;

        // Create output directory if it doesn't exist
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        const fileName = `${this.config.filePrefix}${String(batchNumber).padStart(5, '0')}.json`;
        const filePath = path.join(outputDir, fileName);

        const page: MomentumEventPage = {
            cursor: `batch_${batchNumber}`,
            nextCursor: null, // Will be updated later if needed
            data: transactions
        };

        try {
            const jsonContent = JSON.stringify(page, null, 4);
            fs.writeFileSync(filePath, jsonContent, 'utf-8');
            console.log(`   💾 Saved: ${fileName} (${transactions.length} transactions, ${eventCount} events)`);
        } catch (error) {
            console.error(`   ❌ Error saving ${fileName}:`, error);
        }
    }

    /**
     * Handle retry logic for failed requests
     */
    private async handleRetry(eventType: string, cursor: EventId | null): Promise<void> {
        let retryCount = 0;
        while (retryCount < this.config.maxRetries) {
            retryCount++;
            console.log(`   🔄 Retrying ${eventType}... (${retryCount}/${this.config.maxRetries})`);

            await this.sleep(this.config.retryDelay * retryCount);

            try {
                const result = await this.fetchEventPageOptimized(EventTypes[eventType as EventType], cursor);
                if (result) {
                    console.log(`   ✅ Retry successful for ${eventType}`);
                    return;
                }
            } catch (retryError) {
                if (retryCount === this.config.maxRetries) {
                    console.error(`   ❌ Max retries reached for ${eventType}. Skipping...`);
                }
            }
        }
    }

    /**
     * Fetch a single page of events
     */
    private async fetchEventPage(eventType: string, cursor: EventId | null): Promise<PaginatedEvents | null> {
        const query = {
            MoveEventType: eventType
        };

        const options = {
            cursor,
            limit: this.config.batchSize,
            descending: false
        };

        const result = await this.client.queryEvents({
            query,
            ...options
        });

        return result;
    }

    /**
     * Filter transactions by time range and pool ID
     */
    private filterTransactions(events: SuiEvent[]): MomentumTransaction[] {
        // Group events by transaction digest
        const transactionMap = new Map<string, {
            digest: string;
            timestampMs: string;
            checkpoint: string;
            events: MomentumEvent[];
        }>();

        for (const event of events) {
            const txDigest = event.id.txDigest;
            const timestampMs = event.timestampMs || '0';
            const timestamp = parseInt(timestampMs);

            // Filter by time range
            if (timestamp < this.config.startTime || timestamp > this.config.endTime) {
                continue;
            }

            // Filter by pool ID if specified
            if (this.config.poolId && event.parsedJson &&
                typeof event.parsedJson === 'object' &&
                'pool_id' in event.parsedJson &&
                event.parsedJson.pool_id !== this.config.poolId) {
                continue;
            }

            if (!transactionMap.has(txDigest)) {
                transactionMap.set(txDigest, {
                    digest: txDigest,
                    timestampMs,
                    checkpoint: (event as any).checkpoint?.toString() || '0',
                    events: []
                });
            }

            const transaction = transactionMap.get(txDigest)!;

            // Convert SuiEvent to MomentumEvent format
            const momentumEvent: MomentumEvent = {
                id: {
                    txDigest: event.id.txDigest,
                    eventSeq: event.id.eventSeq.toString()
                },
                packageId: event.packageId,
                transactionModule: event.transactionModule,
                sender: event.sender,
                type: event.type,
                parsedJson: event.parsedJson,
                bcsEncoding: 'base64',
                bcs: event.bcs || ''
            };

            transaction.events.push(momentumEvent);
        }

        return Array.from(transactionMap.values());
    }

    /**
     * Save fetched data to JSON files in the same format as existing data
     */
    async saveToFiles(pages: MomentumEventPage[]): Promise<void> {
        const outputDir = this.config.poolId
            ? path.join(this.config.outputDir, this.config.poolId)
            : this.config.outputDir;

        // Create output directory if it doesn't exist
        if (!fs.existsSync(outputDir)) {
            fs.mkdirSync(outputDir, { recursive: true });
        }

        console.log(`\nSaving ${pages.length} pages to ${outputDir}`);

        for (let i = 0; i < pages.length; i++) {
            const page = pages[i];
            if (page) {
                const fileName = `${this.config.filePrefix}${String(i + 1).padStart(5, '0')}.json`;
                const filePath = path.join(outputDir, fileName);

                try {
                    const jsonContent = JSON.stringify(page, null, 4);
                    fs.writeFileSync(filePath, jsonContent, 'utf-8');
                    console.log(`Saved: ${fileName} (${page.data.length} transactions)`);
                } catch (error) {
                    console.error(`Error saving ${fileName}:`, error);
                }
            }
        }

        console.log(`\nAll files saved to: ${outputDir}`);
    }

    /**
     * Fetch and save all events in one operation
     */
    async fetchAndSave(): Promise<void> {
        try {
            const pages = await this.fetchAllEvents();

            if (pages.length > 0) {
                await this.saveToFiles(pages);
            } else {
                console.log('No events found matching the criteria.');
            }
        } catch (error) {
            console.error('Error in fetchAndSave:', error);
            throw error;
        }
    }

    /**
     * Utility function to sleep for specified milliseconds
     */
    private sleep(ms: number): Promise<void> {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    /**
     * Get the current configuration
     */
    getConfig(): Required<SuiEventFetcherConfig> {
        return { ...this.config };
    }

    /**
     * Update configuration
     */
    updateConfig(newConfig: Partial<SuiEventFetcherConfig>): void {
        this.config = { ...this.config, ...newConfig };

        // Update client if RPC URL changed
        if (newConfig.rpcUrl) {
            this.client = new SuiClient({ url: newConfig.rpcUrl });
        }
    }
}

// Export utility functions
export function createFetcher(config?: SuiEventFetcherConfig): SuiEventFetcher {
    return new SuiEventFetcher(config);
}

export function getEventTypeStrings(eventTypes?: EventType[]): string[] {
    const types = eventTypes || Object.values(EventType);
    return types.map(type => EventTypes[type]);
}
