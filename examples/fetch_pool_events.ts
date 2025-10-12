#!/usr/bin/env bun

/**
 * Example: Fetch events for a specific pool
 * This script demonstrates how to fetch all events for the pool used in your data
 */

import { SuiEventFetcher, EventType } from '../src/sui_event_fetcher';

async function fetchPoolEvents() {
  console.log('🎯 Fetching events for specific pool...\n');

  // The pool ID from your existing data
  const poolId = '0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9';

  const fetcher = new SuiEventFetcher({
    poolId,
    eventTypes: [
      EventType.Swap,
      EventType.AddLiquidity,
      EventType.RemoveLiquidity,
      EventType.RepayFlashSwap
    ],
    batchSize: 50,
    outputDir: './mmt_txs',
    maxRetries: 3
  });

  try {
    await fetcher.fetchAndSave();
    console.log('\n✅ Pool events fetched successfully!');
  } catch (error) {
    console.error('❌ Error fetching pool events:', error);
  }
}

if (import.meta.main) {
  fetchPoolEvents();
}
