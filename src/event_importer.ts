import * as fs from "fs";
import path from "path";
import type { SwapEvent } from "./types";

// ============================================================================
// Constants
// ============================================================================

const DB_PAGE_SIZE = 100;

// ============================================================================
// Types and Enums
// ============================================================================

// Only process Swap and RepayFlashSwap events for backtest framework
enum EventType {
  Swap = "swap",
  RepayFlashSwap = "repayFlashSwap",
}

const EventTypes: Record<EventType, string> = {
  [EventType.Swap]:
    "0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::trade::SwapEvent",
  [EventType.RepayFlashSwap]:
    "0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::trade::RepayFlashSwapEvent",
};

export type SwapEventGeneratorOptions = {
  poolId: string;
  endTime: number; // Unix timestamp in milliseconds
  dataDir?: string; // If not provided, load from DB
  startTime: number; // Optional start time
  silent?: boolean;
};

export type MomentumEvent = {
  id: {
    txDigest: string;
    eventSeq: number;
  };
  type: string;
  sender: string;
  parsedJson: any;
  bcsEncoding: string;
  bcs: string;
};

export type Transaction = {
  digest: string;
  events: MomentumEvent[];
  timestampMs: string;
  checkpoint: string;
};

export type MomentumEventPage = {
  cursor: string | null;
  nextCursor: string | null;
  data: Transaction[];
};

import { rawEventService } from "./services/raw_event_service.js";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Convert signed 32-bit integer to proper tick value
 */
export function convertSigned32BitToTick(bits: number): number {
  if (bits >= 0x80000000) {
    return bits - 0x100000000;
  }
  return bits;
}

/**
 * Sort transactions within a file by timestamp
 */
function sortTransactionsByTimestamp(
  transactions: Transaction[]
): Transaction[] {
  if (transactions.length < 2) return transactions;

  const firstTransaction = transactions[0];
  const lastTransaction = transactions[transactions.length - 1];

  if (firstTransaction && lastTransaction) {
    const firstTimestamp = parseInt(firstTransaction.timestampMs);
    const lastTimestamp = parseInt(lastTransaction.timestampMs);

    if (firstTimestamp > lastTimestamp) {
      return transactions.reverse();
    }
  }

  return transactions;
}

/**
 * Process SwapEvent and RepayFlashSwapEvent, return combined SwapEvent
 * 
 * If the next event is RepayFlashSwapEvent, use its final state.
 * Otherwise, use the SwapEvent state directly.
 */
function processSwapTransaction(
  swapEvent: MomentumEvent,
  nextEvent: MomentumEvent | undefined
): SwapEvent {
  const parsedJson = swapEvent.parsedJson;
  const timestamp = parseInt(swapEvent.id.txDigest.slice(0, 13), 16); // Extract timestamp from tx

  const zeroForOne = parsedJson.x_for_y === true;
  const feeAmount = BigInt(parsedJson.fee_amount || 0);

  // Check if next event is RepayFlashSwap for this same pool
  const isNextEventFlashSwap =
    nextEvent &&
    nextEvent.type === EventTypes[EventType.RepayFlashSwap] &&
    nextEvent.parsedJson?.pool_id === parsedJson.pool_id;

  // If next event is RepayFlashSwap, use its final state
  if (isNextEventFlashSwap && nextEvent) {
    const flashData = nextEvent.parsedJson;

    // Calculate amounts from flash swap
    const amountXDebt = BigInt(flashData.amount_x_debt || 0);
    const amountYDebt = BigInt(flashData.amount_y_debt || 0);
    const paidX = BigInt(flashData.paid_x || 0);
    const paidY = BigInt(flashData.paid_y || 0);

    // For flash swap, amountIn/Out are derived from debt and paid
    const amountIn = zeroForOne ? amountXDebt : amountYDebt;
    const amountOut = zeroForOne ? amountYDebt : amountXDebt;

    // Calculate total fees (flash fee + swap fee)
    const flashFeeX = paidX > amountXDebt ? paidX - amountXDebt : 0n;
    const flashFeeY = paidY > amountYDebt ? paidY - amountYDebt : 0n;
    const swapFeeX = zeroForOne ? feeAmount : 0n;
    const swapFeeY = zeroForOne ? 0n : feeAmount;
    const totalFee = (flashFeeX + swapFeeX) + (flashFeeY + swapFeeY);

    // Return SwapEvent with final state from RepayFlashSwap
    return {
      timestamp,
      poolId: parsedJson.pool_id,
      amountIn,
      amountOut,
      zeroForOne,
      sqrtPriceBefore: BigInt(parsedJson.sqrt_price_before || 0),
      sqrtPriceAfter: BigInt(flashData.sqrt_price_after || parsedJson.sqrt_price_after),
      feeAmount: totalFee,
      liquidity: BigInt(flashData.liquidity || parsedJson.liquidity),
      tick: convertSigned32BitToTick(
        flashData.tick_index?.bits || parsedJson.tick_index?.bits || 0
      ),
      reserveA: BigInt(flashData.reserve_x),
      reserveB: BigInt(flashData.reserve_y),
    };
  } else {
    // Normal swap without flash swap (or flash swap for different pool)
    const amountIn = zeroForOne
      ? BigInt(parsedJson.amount_x || 0)
      : BigInt(parsedJson.amount_y || 0);
    const amountOut = zeroForOne
      ? BigInt(parsedJson.amount_y || 0)
      : BigInt(parsedJson.amount_x || 0);

    return {
      timestamp,
      poolId: parsedJson.pool_id,
      amountIn,
      amountOut,
      zeroForOne,
      sqrtPriceBefore: BigInt(parsedJson.sqrt_price_before || 0),
      sqrtPriceAfter: BigInt(parsedJson.sqrt_price_after),
      feeAmount,
      liquidity: BigInt(parsedJson.liquidity),
      tick: convertSigned32BitToTick(parsedJson.tick_index?.bits || 0),
      reserveA: BigInt(parsedJson.reserve_x),
      reserveB: BigInt(parsedJson.reserve_y),
    };
  }
}

// ============================================================================
// Database Import Generator
// ============================================================================

/**
 * Generate events from database
 */
async function* generateEventsFromDB(options: SwapEventGeneratorOptions): AsyncGenerator<SwapEvent> {
  const logger = options.silent ? undefined : console;
  logger?.log?.(`Generating events from database for pool ${options.poolId}`);

    let offset = 0;

  while (true) {
      const rawEvents = await rawEventService.getEvents({
        offset,
      poolAddress: options.poolId,
      limit: DB_PAGE_SIZE,
      startTime: options.startTime,
      endTime: options.endTime,
    });

      if (!rawEvents.length) break;

      logger?.log?.(
      `Processing ${rawEvents.length} DB events for pool ${options.poolId} (offset ${offset})`
      );

      for (const rawEvent of rawEvents) {
        if (Array.isArray(rawEvent.data?.events)) {
        const events = rawEvent.data.events;

        // Process events sequentially, checking next event
        for (let i = 0; i < events.length; i++) {
          const event = events[i];
          
          // Only process SwapEvent
          if (
            event.type === EventTypes[EventType.Swap] &&
            event.parsedJson?.pool_id === options.poolId
          ) {
            const nextEvent = events[i + 1]; // Check immediate next event
            yield processSwapTransaction(event, nextEvent);
          }
        }
      }
    }

    if (rawEvents.length < DB_PAGE_SIZE) break;
    offset += DB_PAGE_SIZE;
  }

  logger?.log?.(`Finished generating swap events from database`);
}

// ============================================================================
// File System Import Generator
// ============================================================================

/**
 * Resolve directory path for file import
 */
function resolveDataDirectory(dataDir: string, poolId: string): string {
  if (!fs.existsSync(dataDir)) {
    const candidate = path.join(dataDir, poolId);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
    throw new Error(`Directory ${dataDir} does not exist`);
  }

  const entries = fs.readdirSync(dataDir);
  if (!entries.some((file) => file.endsWith(".json"))) {
    const candidate = path.join(dataDir, poolId);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return dataDir;
}

/**
 * Detect and correct file ordering based on timestamps
 */
function sortFilesByTimestamp(
  files: string[],
  dir: string,
  logger?: Partial<Console>
): string[] {
  if (files.length < 2) return files;

    try {
      const firstFilePath = path.join(dir, files[0]!);
      const lastFilePath = path.join(dir, files[files.length - 1]!);

      const firstFileData = JSON.parse(
        fs.readFileSync(firstFilePath, "utf-8")
      ) as MomentumEventPage;
      const lastFileData = JSON.parse(
        fs.readFileSync(lastFilePath, "utf-8")
      ) as MomentumEventPage;

      const firstFileTimestamp = firstFileData.data[0]?.timestampMs
        ? parseInt(firstFileData.data[0].timestampMs)
        : 0;
      const lastFileTimestamp = lastFileData.data[0]?.timestampMs
        ? parseInt(lastFileData.data[0].timestampMs)
        : 0;

      if (firstFileTimestamp > lastFileTimestamp) {
        logger?.log?.(`Detected files in descending order, reversing...`);
      return files.reverse();
      }
    } catch (error) {
      logger?.warn?.(
        `Could not detect file order, proceeding with default sort:`,
        error
      );
    }

  return files;
}

/**
 * Generate events from file system
 */
function* generateEventsFromFiles(options: SwapEventGeneratorOptions): Generator<SwapEvent> {
  const logger = options.silent ? undefined : console;
  const dir = resolveDataDirectory(options.dataDir!, options.poolId);

  // Read and sort files
  let files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort();

  files = sortFilesByTimestamp(files, dir, logger);

  logger?.log?.(`Processing ${files.length} files for pool ${options.poolId}`);

  for (const file of files) {
    try {
      const filePath = path.join(dir, file);
      const data = JSON.parse(
        fs.readFileSync(filePath, "utf-8")
      ) as MomentumEventPage;

      const transactions = sortTransactionsByTimestamp(data.data);

      for (const transaction of transactions) {
        const transactionTimestamp = parseInt(transaction.timestampMs);

        // Stop if reached end time
        if (transactionTimestamp > options.endTime) {
          logger?.log?.(
            `Reached endTime: ${options.endTime}, stopping at ${transactionTimestamp}`
          );
          return;
        }

        // Skip if before start time
        if (options.startTime && transactionTimestamp < options.startTime) {
          continue;
        }

        const events = transaction.events;

        // Process events sequentially, checking next event
        for (let i = 0; i < events.length; i++) {
          const event = events[i];
          
          // Only process SwapEvent
          if (
            event &&
            event.type === EventTypes[EventType.Swap] &&
            event.parsedJson?.pool_id === options.poolId
          ) {
            const nextEvent = events[i + 1]; // Check immediate next event
            yield processSwapTransaction(event, nextEvent);
          }
        }
      }
    } catch (error) {
      logger?.warn?.(`Error processing file ${file}:`, error);
    }
  }

  logger?.log?.(`Finished generating swap events from files`);
}

// ============================================================================
// Main Generator Function
// ============================================================================

/**
 * Create a swap event generator from either database or files
 * 
 * @param options Configuration for event generation
 * @returns AsyncGenerator of SwapEvent
 */
export async function* createSwapEventGenerator(
  options: SwapEventGeneratorOptions
): AsyncGenerator<SwapEvent> {
  const logger = options.silent ? undefined : console;

  logger?.log?.(
    `Creating event generator for pool ${options.poolId} until ${new Date(options.endTime).toISOString()}`
  );

  // Determine import source: DB or file system
  if (!options.dataDir) {
    yield* generateEventsFromDB(options);
  } else {
    yield* generateEventsFromFiles(options);
  }
}

// ============================================================================
// Exports
// ============================================================================

export { EventType, EventTypes };

