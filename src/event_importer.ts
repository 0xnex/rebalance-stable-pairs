import * as fs from "fs";
import path from "path";
import { Pool } from "./pool";

enum EventType {
  Swap = "swap",
  AddLiquidity = "addLiquidity",
  RemoveLiquidity = "removeLiquidity",
  RepayFlashSwap = "repayFlashSwap",
  CreatePool = "createPool",
  OpenPosition = "openPosition",
}

const EventTypes: Record<EventType, string> = {
  [EventType.Swap]:
    "0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::trade::SwapEvent",
  [EventType.AddLiquidity]:
    "0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::liquidity::AddLiquidityEvent",
  [EventType.RemoveLiquidity]:
    "0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::liquidity::RemoveLiquidityEvent",
  [EventType.RepayFlashSwap]:
    "0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::trade::RepayFlashSwapEvent",
  [EventType.CreatePool]:
    "0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::create_pool::PoolCreatedEvent",
  [EventType.OpenPosition]:
    "0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::liquidity::OpenPositionEvent",
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

type ImportOptions = {
  silent?: boolean;
  dataDir?: string;
  seedEventCount?: number;
  startTime?: number;
  endTime?: number;
  dumpStateAt?: number; // timestamp to dump pool state
  dumpStatePath?: string; // path to save the dumped state
};

import { rawEventService } from "./services/raw_event_service.js";

function commonProcessEvent({
  pool,
  eventType,
  parsedJson,
  poolId,
  eventTypes,
  logger,
}: {
  pool: Pool;
  eventType: string;
  parsedJson: any;
  poolId: string;
  eventTypes?: EventType[];
  logger?: Partial<Console>;
}): { pool: Pool; handled: boolean } {
  if (parsedJson.pool_id !== poolId) return { pool, handled: false };
  let handled = false;
  if (eventTypes && eventTypes.length > 0) {
    const isTargetEvent = eventTypes.some(
      (targetType) => eventType === EventTypes[targetType]
    );
    if (!isTargetEvent) return { pool, handled: false };
  }
  try {
    switch (eventType) {
      case EventTypes[EventType.CreatePool]:
        pool = processCreatePoolEvent(parsedJson, logger);
        logger?.log?.(
          `Processed CreatePool event for pool ${parsedJson.pool_id}`
        );
        handled = true;
        break;
      case EventTypes[EventType.Swap]:
        processSwapEvent(pool, parsedJson, { logger });
        handled = true;
        break;
      case EventTypes[EventType.AddLiquidity]:
        processAddLiquidityEvent(pool, parsedJson, { logger });
        handled = true;
        break;
      case EventTypes[EventType.RemoveLiquidity]:
        processRemoveLiquidityEvent(pool, parsedJson, { logger });
        handled = true;
        break;
      case EventTypes[EventType.RepayFlashSwap]:
        processRepayFlashSwapEvent(pool, parsedJson);
        handled = true;
        break;
      case EventTypes[EventType.OpenPosition]:
        processOpenPositionEvent(pool, parsedJson);
        handled = true;
        break;
      default:
        // Skip unknown event types
        break;
    }
  } catch (error) {
    logger?.warn?.(`Error processing event:`, error);
    // Continue processing other events
  }
  return { pool, handled };
}

function logValidationStats(
  pool: Pool,
  poolId: string,
  logger?: Partial<Console>
) {
  logger?.log?.(`Finished processing events for pool ${poolId}`);
  // Log validation statistics
  const validationStats = pool.getValidationStats();
  logger?.log?.(`\n📊 Validation Statistics:`, {
    totalSwaps: validationStats.totalSwaps,
    exactMatchRate: `${(validationStats.exactMatchRate * 100).toFixed(2)}%`,
    amountOutMatchRate: `${(validationStats.amountOutMatchRate * 100).toFixed(
      2
    )}%`,
    feeMatchRate: `${(validationStats.feeMatchRate * 100).toFixed(2)}%`,
    protocolFeeMatchRate: `${(
      validationStats.protocolFeeMatchRate * 100
    ).toFixed(2)}%`,
    mismatches: {
      amountOut: validationStats.amountOutMismatches,
      fee: validationStats.feeMismatches,
      protocolFee: validationStats.protocolFeeMismatches,
    },
    totalDifferences: {
      amountOut: validationStats.totalAmountOutDifference.toString(),
      fee: validationStats.totalFeeDifference.toString(),
      protocolFee: validationStats.totalProtocolFeeDifference.toString(),
    },
  });
}

async function importEvents(
  poolId: string,
  untilTimestamp: number,
  eventTypes?: EventType[],
  options?: ImportOptions
): Promise<Pool> {
  const logger = options?.silent ? undefined : console;
  console.log("options: ", options);
  // If dataDir is falsy, import from DB
  if (!options?.dataDir) {
    console.log("options.dataDir is falsy, importing from DB");
    // DB: Each record is a transaction with 1 event
    // ...same logic as file-based, but each DB row is a transaction with 1 event
    // Initialize pool with default values (will be updated from CreatePool event)
    let pool = new Pool(0.003, 2); // Default fee rate and tick spacing

    // Fetch events from database in pages of 100
    const pageSize = 100;
    let offset = 0;
    const seedLimit = options?.seedEventCount;
    let processedSeedEvents = 0;
    let done = false;
    while (!done) {
      const rawEvents = await rawEventService.getEvents({
        offset,
        poolAddress: poolId,
        limit: pageSize,
        startTime: options?.startTime,
        endTime: options?.endTime,
      });
      if (!rawEvents.length) break;
      logger?.log?.(
        `Processing ${rawEvents.length} DB events for pool ${poolId} (offset ${offset})`
      );
      for (const rawEvent of rawEvents) {
        // Check if we need to dump state (for DB import, we need to check timestamp from rawEvent)
        if (
          options?.dumpStateAt &&
          rawEvent.timestamp &&
          parseInt(rawEvent.timestamp.toString()) >= options.dumpStateAt &&
          !(pool as any).dumped
        ) {
          const dumpPath =
            options.dumpStatePath ||
            `pool_state_${poolId}_${options.dumpStateAt}.json`;
          const stateJson = pool.serialize();
          fs.writeFileSync(dumpPath, stateJson);
          logger?.log?.(
            `💾 Pool state dumped to ${dumpPath} at timestamp ${rawEvent.timestamp}`
          );
          (pool as any).dumped = true;
        }

        // If rawEvent.data.events exists (array), treat as multiple events (like file import)
        if (Array.isArray(rawEvent.data?.events)) {
          for (const event of rawEvent.data.events) {
            const eventType = event.type;
            const parsedJson = event.parsedJson;
            const result = commonProcessEvent({
              pool,
              eventType,
              parsedJson,
              poolId,
              eventTypes,
              logger,
            });
            pool = result.pool;
            if (result.handled) {
              processedSeedEvents += 1;
              if (seedLimit !== undefined && processedSeedEvents >= seedLimit) {
                done = true;
                break;
              }
            }
          }
        }
      }
      if (rawEvents.length < pageSize) break;
      offset += pageSize;
    }
    logValidationStats(pool, poolId, logger);
    return pool;
  }

  // File-based logic as before
  let dir = options.dataDir;
  if (!fs.existsSync(dir)) {
    const candidate = path.join(dir, poolId);
    if (fs.existsSync(candidate)) {
      dir = candidate;
    } else {
      throw new Error(`Directory ${dir} does not exist`);
    }
  }
  const entries = fs.readdirSync(dir);
  if (!entries.some((file) => file.endsWith(".json"))) {
    const candidate = path.join(dir, poolId);
    if (fs.existsSync(candidate)) {
      dir = candidate;
    }
  }

  // Initialize pool with default values (will be updated from CreatePool event)
  let pool = new Pool(0.003, 2); // Default fee rate and tick spacing

  // Read all JSON files in the directory
  let files = fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort(); // Process files in order

  // Detect if files are in descending chronological order by comparing first and last file
  if (files.length >= 2) {
    try {
      const firstFilePath = path.join(dir, files[0]!);
      const lastFilePath = path.join(dir, files[files.length - 1]!);

      const firstFileData = JSON.parse(
        fs.readFileSync(firstFilePath, "utf-8")
      ) as MomentumEventPage;
      const lastFileData = JSON.parse(
        fs.readFileSync(lastFilePath, "utf-8")
      ) as MomentumEventPage;

      // Get first transaction timestamp from each file
      const firstFileTimestamp = firstFileData.data[0]?.timestampMs
        ? parseInt(firstFileData.data[0].timestampMs)
        : 0;
      const lastFileTimestamp = lastFileData.data[0]?.timestampMs
        ? parseInt(lastFileData.data[0].timestampMs)
        : 0;

      // If first file has newer events than last file, files are in descending order
      if (firstFileTimestamp > lastFileTimestamp) {
        logger?.log?.(`Detected files in descending order, reversing...`);
        files = files.reverse();
      }
    } catch (error) {
      logger?.warn?.(
        `Could not detect file order, proceeding with default sort:`,
        error
      );
    }
  }

  logger?.log?.(`Processing ${files.length} files for pool ${poolId}`);
  const seedLimit = options?.seedEventCount;
  let processedSeedEvents = 0;
  for (const file of files) {
    try {
      const filePath = path.join(dir, file);
      const data = JSON.parse(
        fs.readFileSync(filePath, "utf-8")
      ) as MomentumEventPage;

      // Reverse transactions within the file if they are in descending order
      let transactions = data.data;
      if (transactions.length >= 2) {
        const firstTransaction = transactions[0];
        const lastTransaction = transactions[transactions.length - 1];

        if (firstTransaction && lastTransaction) {
          const firstTransactionTimestamp = parseInt(
            firstTransaction.timestampMs
          );
          const lastTransactionTimestamp = parseInt(
            lastTransaction.timestampMs
          );

          // If first transaction is newer than last, reverse the order
          if (firstTransactionTimestamp > lastTransactionTimestamp) {
            transactions = transactions.reverse();
          }
        }
      }

      for (const transaction of transactions) {
        const transactionTimestamp = parseInt(transaction.timestampMs);

        // Dump pool state if we've reached the specified dump timestamp
        if (
          options?.dumpStateAt &&
          transactionTimestamp >= options.dumpStateAt &&
          !(pool as any).dumped
        ) {
          const dumpPath =
            options.dumpStatePath ||
            `pool_state_${poolId}_${options.dumpStateAt}.json`;
          const stateJson = pool.serialize();
          fs.writeFileSync(dumpPath, stateJson);
          logger?.log?.(
            `💾 Pool state dumped to ${dumpPath} at timestamp ${transactionTimestamp}`
          );
          // Mark as dumped to avoid multiple dumps
          (pool as any).dumped = true;
        }

        // Stop processing if we've reached the specified timestamp
        if (transactionTimestamp > untilTimestamp) {
          logger?.log?.(
            `Reached timestamp limit: ${untilTimestamp}, stopping at ${transactionTimestamp}`
          );
          return pool;
        }
        for (const event of transaction.events) {
          const eventType = event.type;
          const parsedJson = event.parsedJson;
          const result = commonProcessEvent({
            pool,
            eventType,
            parsedJson,
            poolId,
            eventTypes,
            logger,
          });
          pool = result.pool;
          if (result.handled) {
            processedSeedEvents += 1;
            if (seedLimit !== undefined && processedSeedEvents >= seedLimit) {
              return pool;
            }
          }
        }
      }
    } catch (error) {
      logger?.warn?.(`Error processing file ${file}:`, error);
      // Continue processing other files
    }
  }
  logValidationStats(pool, poolId, logger);
  return pool;
}

/**
  "fee_rate": "10",
  "pool_id": "0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9",
  "sender": "0x506ecadb1d93eb2f9e7e1d32e5146b60d734f6d02bd763e8ec705ba00eaded30",
  "tick_spacing": 2,
  "type_x": {
    "name": "375f70cf2ae4c00bf37117d0c85a2c71545e6ee05c4a5c7d282cd66a4504b068::usdt::USDT"
  },
  "type_y": {
    "name": "dba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC"
  }
 * 
 */

function processCreatePoolEvent(
  parsedJson: any,
  logger?: Partial<Console>
): Pool {
  const feeRateRaw = BigInt(parsedJson.fee_rate || 0);
  const feeRate = Number(feeRateRaw) / 10000; // Convert from basis points-like format for legacy usage
  const tickSpacing = parsedJson.tick_spacing;

  logger?.log?.(
    `Creating pool with fee rate: ${feeRate}, tick spacing: ${tickSpacing}`
  );
  logger?.log?.(`Pool creation data:`, {
    feeRate,
    tickSpacing,
    poolId: parsedJson.pool_id,
    typeX: parsedJson.type_x,
    typeY: parsedJson.type_y,
  });

  const pool = new Pool(feeRate, tickSpacing, feeRateRaw);

  // Initialize pool with initial state if available
  if (parsedJson.initial_sqrt_price) {
    pool.sqrtPriceX64 = BigInt(parsedJson.initial_sqrt_price);
    pool.tickCurrent = pool.sqrtPriceToTick(pool.sqrtPriceX64);
  } else {
    // Initialize with default price (1:1 ratio) if no initial price provided
    pool.sqrtPriceX64 = pool.tickToSqrtPrice(0); // Set to tick 0 (price = 1)
    pool.tickCurrent = 0;
  }

  // Set initial reserves if available
  if (parsedJson.initial_reserve_x !== undefined) {
    pool.reserveA = BigInt(parsedJson.initial_reserve_x);
  }
  if (parsedJson.initial_reserve_y !== undefined) {
    pool.reserveB = BigInt(parsedJson.initial_reserve_y);
  }

  // Set initial liquidity if available
  if (parsedJson.initial_liquidity !== undefined) {
    pool.liquidity = BigInt(parsedJson.initial_liquidity);
  }

  // Set initial fee growth if available
  if (parsedJson.initial_fee_growth_global_0_x64 !== undefined) {
    pool.feeGrowthGlobal0X64 = BigInt(
      parsedJson.initial_fee_growth_global_0_x64
    );
  }
  if (parsedJson.initial_fee_growth_global_1_x64 !== undefined) {
    pool.feeGrowthGlobal1X64 = BigInt(
      parsedJson.initial_fee_growth_global_1_x64
    );
  }

  logger?.log?.(
    `Pool initialized with sqrtPriceX64: ${pool.sqrtPriceX64.toString()}, tickCurrent: ${
      pool.tickCurrent
    }, reserves: ${pool.reserveA}/${pool.reserveB}, liquidity: ${
      pool.liquidity
    }`
  );

  return pool;
}

export function processSwapEvent(
  pool: Pool,
  parsedJson: any,
  options?: { logger?: Partial<Console> }
): void {
  const logger = options?.logger;
  // Parse swap event with correct field names for trade::SwapEvent
  const zeroForOne = parsedJson.x_for_y === true; // x_for_y true → token0 in, token1 out
  const amountIn = zeroForOne
    ? BigInt(parsedJson.amount_x || 0)
    : BigInt(parsedJson.amount_y || 0);
  const expectedAmountOut = zeroForOne
    ? BigInt(parsedJson.amount_y || 0)
    : BigInt(parsedJson.amount_x || 0);
  const expectedFee = BigInt(parsedJson.fee_amount || 0);
  const expectedProtocolFee = BigInt(parsedJson.protocol_fee || 0);

  if (parsedJson.sqrt_price_before) {
    pool.sqrtPriceX64 = BigInt(parsedJson.sqrt_price_before);
    pool.tickCurrent = convertSigned32BitToTick(
      parsedJson.tick_index?.bits || pool.tickCurrent
    );
  }
  if (parsedJson.liquidity) {
    pool.liquidity = BigInt(parsedJson.liquidity);
  }
  if (parsedJson.reserve_x && parsedJson.reserve_y) {
    pool.reserveA = BigInt(parsedJson.reserve_x);
    pool.reserveB = BigInt(parsedJson.reserve_y);
  }

  if (amountIn > 0) {
    // Use validation method to compare with event data
    const result = pool.applySwapWithValidation(
      amountIn,
      zeroForOne,
      expectedAmountOut > 0 ? expectedAmountOut : undefined,
      expectedFee > 0 ? expectedFee : undefined,
      expectedProtocolFee > 0 ? expectedProtocolFee : undefined
    );

    // Log validation results
    if (!result.validation.isExactMatch) {
      logger?.warn?.(`❌ Swap validation FAILED:`, {
        transaction: parsedJson,
        calculated: {
          amountOut: result.amountOut.toString(),
          fee: result.feeAmount.toString(),
          protocolFee: result.protocolFee.toString(),
        },
        expected: {
          amountOut: expectedAmountOut.toString(),
          fee: expectedFee.toString(),
          protocolFee: expectedProtocolFee.toString(),
        },
        differences: {
          amountOut: result.validation.amountOutDifference.toString(),
          fee: result.validation.feeDifference.toString(),
          protocolFee: result.validation.protocolFeeDifference.toString(),
        },
        validation: {
          amountOutMatch: result.validation.amountOutMatch,
          feeMatch: result.validation.feeMatch,
          protocolFeeMatch: result.validation.protocolFeeMatch,
          isExactMatch: result.validation.isExactMatch,
        },
      });
    } else {
      logger?.log?.(
        `✅ Swap validation PASSED for amount ${amountIn.toString()}`
      );
    }
  }
}

export function processAddLiquidityEvent(
  pool: Pool,
  parsedJson: any,
  options?: { logger?: Partial<Console> }
): void {
  const logger = options?.logger;
  // Use the correct field names from the actual data
  // Convert signed 32-bit integers to proper tick values
  const tickLower = convertSigned32BitToTick(
    parsedJson.lower_tick_index?.bits || 0
  );
  const tickUpper = convertSigned32BitToTick(
    parsedJson.upper_tick_index?.bits || 0
  );
  const amountA = BigInt(parsedJson.amount_x || 0);
  const amountB = BigInt(parsedJson.amount_y || 0);
  const liquidityDelta = BigInt(parsedJson.liquidity || 0);

  logger?.log?.(`Processing AddLiquidity event:`, {
    tickLower,
    tickUpper,
    amountA: amountA.toString(),
    amountB: amountB.toString(),
    reserveX: parsedJson.reserve_x,
    reserveY: parsedJson.reserve_y,
    liquidity: parsedJson.liquidity,
  });

  if (liquidityDelta !== 0n) {
    pool.applyLiquidityDelta(tickLower, tickUpper, liquidityDelta);
    if (parsedJson.liquidity) {
      pool.liquidity = BigInt(parsedJson.liquidity);
    }
    if (parsedJson.reserve_x && parsedJson.reserve_y) {
      pool.reserveA = BigInt(parsedJson.reserve_x);
      pool.reserveB = BigInt(parsedJson.reserve_y);
    }
    logger?.log?.(
      `Added liquidity: ${amountA.toString()} A, ${amountB.toString()} B`
    );
    logger?.log?.(`Pool state after add:`, {
      reserveA: pool.reserveA.toString(),
      reserveB: pool.reserveB.toString(),
      liquidity: pool.liquidity.toString(),
    });
  }
}

// Convert signed 32-bit integer to proper tick value
export function convertSigned32BitToTick(bits: number): number {
  // Convert unsigned 32-bit to signed 32-bit
  if (bits >= 0x80000000) {
    return bits - 0x100000000;
  }
  return bits;
}

export function processRemoveLiquidityEvent(
  pool: Pool,
  parsedJson: any,
  options?: { logger?: Partial<Console> }
): void {
  const logger = options?.logger;
  const tickLower = convertSigned32BitToTick(
    parsedJson.lower_tick_index?.bits || parsedJson.tick_lower || 0
  );
  const tickUpper = convertSigned32BitToTick(
    parsedJson.upper_tick_index?.bits || parsedJson.tick_upper || 0
  );
  const liquidityDelta = -BigInt(parsedJson.liquidity || 0);

  if (liquidityDelta !== 0n) {
    pool.applyLiquidityDelta(tickLower, tickUpper, liquidityDelta);
    if (parsedJson.liquidity) {
      pool.liquidity = BigInt(parsedJson.liquidity);
    }
    if (parsedJson.reserve_x && parsedJson.reserve_y) {
      pool.reserveA = BigInt(parsedJson.reserve_x);
      pool.reserveB = BigInt(parsedJson.reserve_y);
    }
  }
}

export function processRepayFlashSwapEvent(pool: Pool, parsedJson: any): void {
  // Parse flash swap repayment event data
  const amountXDebt = BigInt(parsedJson.amount_x_debt || 0);
  const amountYDebt = BigInt(parsedJson.amount_y_debt || 0);
  const paidX = BigInt(parsedJson.paid_x || 0);
  const paidY = BigInt(parsedJson.paid_y || 0);
  const reserveX = parsedJson.reserve_x
    ? BigInt(parsedJson.reserve_x)
    : undefined;
  const reserveY = parsedJson.reserve_y
    ? BigInt(parsedJson.reserve_y)
    : undefined;

  // Apply the flash swap repayment to adjust reserves
  pool.applyRepayFlashSwap(
    amountXDebt,
    amountYDebt,
    paidX,
    paidY,
    reserveX,
    reserveY
  );
}

function processOpenPositionEvent(_pool: Pool, _parsedJson: any): void {
  // OpenPosition event does not change pool state nor strategy state for backtests
}

// Load pool from dumped state file
export function loadPoolFromState(stateFilePath: string): Pool {
  if (!fs.existsSync(stateFilePath)) {
    throw new Error(`Pool state file not found: ${stateFilePath}`);
  }

  const stateJson = fs.readFileSync(stateFilePath, "utf-8");
  return Pool.deserialize(stateJson);
}

// Export the main function and types
export { EventType, EventTypes, importEvents };
export type { ImportOptions };
