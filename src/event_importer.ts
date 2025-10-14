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
};

import { rawEventService } from "./services/raw_event_service.js";

function commonProcessEvent({
  pool,
  eventType,
  parsedJson,
  poolId,
  eventTypes,
  logger,
  transactionEvents,
  txDigest,
  eventSeq,
  fileName,
}: {
  pool: Pool;
  eventType: string;
  parsedJson: any;
  poolId: string;
  eventTypes?: EventType[];
  logger?: Partial<Console>;
  transactionEvents?: MomentumEvent[]; // All events in current transaction
  txDigest?: string;
  eventSeq?: number;
  fileName?: string;
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
        processSwapEvent(pool, parsedJson, {
          logger,
          transactionEvents,
          txDigest,
          eventSeq,
          fileName,
        });
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
        // RepayFlashSwap is now handled together with SwapEvent
        // Skip standalone processing
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

async function importEvents(
  poolId: string,
  untilTimestamp: number,
  eventTypes?: EventType[],
  options?: ImportOptions
): Promise<Pool> {
  const logger = options?.silent ? undefined : console;

  // Output CSV header for validation mismatches
  console.log("\n=== CSV Validation Report ===");
  console.log("文件,tx,序号,事件,对比字段,期望值,实际值");
  // If dataDir is falsy, import from DB
  if (!options?.dataDir) {
    console.log("options.dataDir is falsy, importing from DB");
    // DB: Each record is a transaction with 1 event
    // ...same logic as file-based, but each DB row is a transaction with 1 event
    // Initialize pool with default values (will be updated from CreatePool event)
    let pool = new Pool(3000n, 2); // Default fee rate (0.3% = 3000 ppm) and tick spacing

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
              transactionEvents: rawEvent.data?.events,
              txDigest: rawEvent.data?.digest || event.id?.txDigest,
              eventSeq: event.id?.eventSeq,
              fileName: "db_import",
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

    // End CSV report
    console.log("=== End of CSV Validation Report ===\n");

    // Log final pool state summary
    logger?.log?.(`\n📊 Final Pool State Summary:`);
    logger?.log?.(`  Pool ID: ${poolId}`);
    logger?.log?.(`  Liquidity: ${pool.liquidity.toString()}`);
    logger?.log?.(`  SqrtPriceX64: ${pool.sqrtPriceX64.toString()}`);
    logger?.log?.(`  Current Tick: ${pool.tickCurrent}`);
    logger?.log?.(`  Reserve A (X): ${pool.reserveA.toString()}`);
    logger?.log?.(`  Reserve B (Y): ${pool.reserveB.toString()}`);
    logger?.log?.(
      `  Fee Growth Global 0: ${pool.feeGrowthGlobal0X64.toString()}`
    );
    logger?.log?.(
      `  Fee Growth Global 1: ${pool.feeGrowthGlobal1X64.toString()}`
    );
    logger?.log?.(`  Total Swap Fee 0: ${pool.totalSwapFee0.toString()}`);
    logger?.log?.(`  Total Swap Fee 1: ${pool.totalSwapFee1.toString()}`);
    logger?.log?.(`  Active Ticks: ${pool.ticks.size}`);
    logger?.log?.(`  Processed Events: ${processedSeedEvents}`);

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
  let pool = new Pool(3000n, 2); // Default fee rate (0.3% = 3000 ppm) and tick spacing

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
            transactionEvents: transaction.events,
            txDigest: transaction.digest,
            eventSeq: event.id?.eventSeq,
            fileName: file,
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

  // End CSV report
  console.log("=== End of CSV Validation Report ===\n");

  // Log final pool state summary
  logger?.log?.(`\n📊 Final Pool State Summary:`);
  logger?.log?.(`  Pool ID: ${poolId}`);
  logger?.log?.(`  Liquidity: ${pool.liquidity.toString()}`);
  logger?.log?.(`  SqrtPriceX64: ${pool.sqrtPriceX64.toString()}`);
  logger?.log?.(`  Current Tick: ${pool.tickCurrent}`);
  logger?.log?.(`  Reserve A (X): ${pool.reserveA.toString()}`);
  logger?.log?.(`  Reserve B (Y): ${pool.reserveB.toString()}`);
  logger?.log?.(
    `  Fee Growth Global 0: ${pool.feeGrowthGlobal0X64.toString()}`
  );
  logger?.log?.(
    `  Fee Growth Global 1: ${pool.feeGrowthGlobal1X64.toString()}`
  );
  logger?.log?.(`  Total Swap Fee 0: ${pool.totalSwapFee0.toString()}`);
  logger?.log?.(`  Total Swap Fee 1: ${pool.totalSwapFee1.toString()}`);
  logger?.log?.(`  Active Ticks: ${pool.ticks.size}`);
  logger?.log?.(`  Processed Events: ${processedSeedEvents}`);

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
  const feeRate = Number(feeRateRaw) / 1_000_000; // Convert from basis points-like format for legacy usage
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

  const pool = new Pool(feeRateRaw, tickSpacing);

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
  options?: {
    logger?: Partial<Console>;
    transactionEvents?: MomentumEvent[];
    txDigest?: string;
    eventSeq?: number;
    fileName?: string;
  }
): void {
  const logger = options?.logger;
  const transactionEvents = options?.transactionEvents || [];
  const txDigest = options?.txDigest || "unknown";
  const eventSeq = options?.eventSeq ?? 0;
  const fileName = options?.fileName || "unknown";

  // Check if there's a RepayFlashSwapEvent in the same transaction for this pool
  const flashSwapEvent = transactionEvents.find(
    (evt) =>
      evt.type === EventTypes[EventType.RepayFlashSwap] &&
      evt.parsedJson?.pool_id === parsedJson.pool_id
  );

  // Removed verbose flash swap detection log to keep CSV report clean
  // if (flashSwapEvent) {
  //   logger?.log?.(
  //     `  Found RepayFlashSwapEvent in transaction for pool ${parsedJson.pool_id}`
  //   );
  // }

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

  // Check if this is a same-token flash swap
  let isFlashSwapSameToken = false;
  if (flashSwapEvent) {
    const flashData = flashSwapEvent.parsedJson;
    const amountXDebt = BigInt(flashData.amount_x_debt || 0);
    const amountYDebt = BigInt(flashData.amount_y_debt || 0);
    const paidX = BigInt(flashData.paid_x || 0);
    const paidY = BigInt(flashData.paid_y || 0);

    // Same token case: debt and paid are equal (no extra fee in repayment)
    // Example: debt_x=219029, paid_x=219029, debt_y=0, paid_y=0
    const sameTokenX =
      amountXDebt === paidX && amountYDebt === 0n && paidY === 0n;
    const sameTokenY =
      amountYDebt === paidY && amountXDebt === 0n && paidX === 0n;

    isFlashSwapSameToken = sameTokenX || sameTokenY;

    if (isFlashSwapSameToken) {
      // Same token flash swap - just collect the fee from SwapEvent, don't execute swap
      // The fee is in SwapEvent.fee_amount, not in the RepayFlashSwap diff
      const paidX = BigInt(flashData.paid_x || 0);
      const paidY = BigInt(flashData.paid_y || 0);

      // Calculate actual fee from RepayFlashSwap (should be 0 for same-token)
      const feeCollectedX = paidX > amountXDebt ? paidX - amountXDebt : 0n;
      const feeCollectedY = paidY > amountYDebt ? paidY - amountYDebt : 0n;

      // The real fee is in SwapEvent.fee_amount - add it based on direction
      const swapFeeX = zeroForOne ? expectedFee : 0n;
      const swapFeeY = zeroForOne ? 0n : expectedFee;

      // Create synthetic paid amounts that include the swap fee
      const effectivePaidX = paidX + swapFeeX;
      const effectivePaidY = paidY + swapFeeY;

      pool.applyRepayFlashSwap(
        amountXDebt,
        amountYDebt,
        effectivePaidX,
        effectivePaidY,
        parsedJson.reserve_x ? BigInt(parsedJson.reserve_x) : undefined,
        parsedJson.reserve_y ? BigInt(parsedJson.reserve_y) : undefined
      );

      // Verbose flash swap log - comment out to keep CSV report clean
      // logger?.log?.(
      //   `  ⚡ Same-token flash swap detected: ` +
      //     `x_for_y=${zeroForOne}, ` +
      //     `debt=(${amountXDebt}, ${amountYDebt}), ` +
      //     `paid=(${paidX}, ${paidY}), ` +
      //     `repay_fee=(${feeCollectedX}, ${feeCollectedY}), ` +
      //     `swap_fee=${expectedFee}, ` +
      //     `total_fee=(${swapFeeX}, ${swapFeeY})`
      // );

      // Sync sqrt_price and tick to match the event
      if (parsedJson.sqrt_price_after) {
        pool.sqrtPriceX64 = BigInt(parsedJson.sqrt_price_after);
        pool.tickCurrent = convertSigned32BitToTick(
          parsedJson.tick_index?.bits || pool.tickCurrent
        );
      }

      // Sync liquidity to event value
      if (parsedJson.liquidity) {
        pool.liquidity = BigInt(parsedJson.liquidity);
      }

      return; // Skip normal swap processing
    }
    // Cross-token flash swap - process as normal swap
    // Verbose log commented out to keep CSV report clean
    // else {
    //   logger?.log?.(
    //     `  🔄 Cross-token flash swap detected: will process as normal swap`
    //   );
    // }
  }

  // Normal swap processing (or cross-token flash swap)
  if (amountIn > 0) {
    // Use validation method to compare with event data
    const result = pool.applySwapWithValidation(
      amountIn,
      zeroForOne,
      expectedAmountOut > 0 ? expectedAmountOut : undefined,
      expectedFee > 0 ? expectedFee : undefined,
      expectedProtocolFee > 0 ? expectedProtocolFee : undefined
    );

    // Log validation results in CSV format
    if (!result.validation.isExactMatch) {
      // Output CSV header on first mismatch (or you can output it at the start of import)
      // Format: 文件, tx, 序号, 事件, 对比字段, 期望值, 实际值

      if (!result.validation.amountOutMatch) {
        console.log(
          `${fileName},${txDigest},${eventSeq},SwapEvent,amountOut,${expectedAmountOut},${result.amountOut}`
        );
      }

      if (!result.validation.feeMatch) {
        console.log(
          `${fileName},${txDigest},${eventSeq},SwapEvent,fee,${expectedFee},${result.feeAmount}`
        );
      }

      if (!result.validation.protocolFeeMatch) {
        console.log(
          `${fileName},${txDigest},${eventSeq},SwapEvent,protocolFee,${expectedProtocolFee},${result.protocolFee}`
        );
      }
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

export function processRepayFlashSwapEvent(
  pool: Pool,
  parsedJson: any,
  options?: { logger?: Partial<Console> }
): void {
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

  // Validate flash swap repayment data
  if (paidX < amountXDebt || paidY < amountYDebt) {
    options?.logger?.warn?.(
      `Flash swap repayment: paid amounts less than debt amounts. ` +
        `X: paid=${paidX}, debt=${amountXDebt}, Y: paid=${paidY}, debt=${amountYDebt}`
    );
  }

  // Calculate fees collected
  const feeX = paidX > amountXDebt ? paidX - amountXDebt : 0n;
  const feeY = paidY > amountYDebt ? paidY - amountYDebt : 0n;

  if (feeX > 0n || feeY > 0n) {
    options?.logger?.log?.(
      `Flash swap repayment: collected fees X=${feeX}, Y=${feeY}`
    );
  }

  // Apply the flash swap repayment to collect fees and update tick data
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
