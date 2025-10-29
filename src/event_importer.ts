import * as fs from "fs";
import path from "path";

// only process swap event
const SwapEventId =
  "0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::trade::SwapEvent";

/**
 * "parsedJson": {
    "amount_x": "107606",
    "amount_y": "107676",
    "fee_amount": "2",
    "liquidity": "9639451503",
    "pool_id": "0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9",
    "protocol_fee": "0",
    "reserve_x": "4613645",
    "reserve_y": "3951616",
    "sender": "0x9cecb2cbb3a3fe5145a8306347cdc38158115337c15bf54e863e68538465c400",
    "sqrt_price_after": "18452667730951209248",
    "sqrt_price_before": "18452461678281015883",
    "tick_index": { "bits": 6 },
    "x_for_y": false
  },
 */

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
  timestampMs: number;
  checkpoint: string;
};

export type Page = {
  cursor: string | null;
  nextCursor: string | null;
  data: Transaction[];
};

type ImportOptions = {
  silent?: boolean;
  dataDir?: string;
  seedEventCount?: number;
  startTime: number;
  endTime: number;
};

import { rawEventService } from "./services/raw_event_service.js";
import type { SwapEvent } from "./backtest_engine.js";

async function* importEvents(poolId: string, option: ImportOptions) {
  console.log(`Importing events for pool ${poolId} from ${option.dataDir}...`);
  if (option.dataDir) {
    yield* fetchEventsFromFile(
      option.dataDir,
      poolId,
      option.startTime,
      option.endTime
    );
  } else {
    yield* fetchEventsFromDb(poolId, option.startTime, option.endTime);
  }
  console.log(`Importing events for pool ${poolId} completed`);
}

async function* fetchEventsFromDb(
  poolId: string,
  startTime: number,
  endTime: number
): AsyncGenerator<SwapEvent> {
  let offset = 0;
  while (true) {
    const rawEvents = await rawEventService.getEvents({
      poolAddress: poolId,
      limit: 100,
      offset: offset,
      startTime: startTime,
      endTime: endTime,
    });
    console.log(
      `Fetching ${rawEvents.length} DB events for pool ${poolId} (offset ${offset})`
    );
    for (const rawEvent of rawEvents) {
      // Handle DB event structure - rawEvent.data contains the actual event data
      const eventData = rawEvent.data;
      if (!eventData) continue;

      const tx = {
        digest: rawEvent.tx_id,
        timestampMs: Number(rawEvent.timestamp_ms),
        events: [
          {
            id: {
              txDigest: rawEvent.tx_id,
              eventSeq: Number(rawEvent.num_of_events || 0),
            },
            type: rawEvent.event_name, // Event type from DB
            parsedJson: eventData, // Actual event data
          },
        ],
      };

      if (tx.timestampMs < startTime) continue;
      if (tx.timestampMs > endTime) return;
      yield* processTransaction(tx, poolId);
    }
    if (rawEvents.length < 100) break;
    offset += 100;
  }
}

async function* fetchEventsFromFile(
  dataDir: string,
  poolId: string,
  startTime: number,
  endTime: number
) {
  try {
    const entries = fs.readdirSync(dataDir);
    const jsonFiles = entries.filter((file) => file.endsWith(".json")).sort(); // Sort files alphabetically (page_00000.json, page_00001.json, ...)

    if (jsonFiles.length === 0) {
      console.warn(`No JSON files found in directory: ${dataDir}`);
      return;
    }

    console.log(`Processing ${jsonFiles.length} files in sorted order`);

    // Collect all events from all files first, then sort by timestamp
    const allEvents: SwapEvent[] = [];

    for (const file of jsonFiles) {
      try {
        const filePath = path.join(dataDir, file);
        const fileContent = fs.readFileSync(filePath, "utf-8");
        const data = JSON.parse(fileContent) as Page;

        if (!data.data || !Array.isArray(data.data)) {
          console.warn(
            `Invalid file structure in ${file}: missing or invalid data array`
          );
          continue;
        }

        for (const transaction of data.data) {
          if (!transaction.timestampMs) {
            console.warn(`Transaction missing timestamp in ${file}`);
            continue;
          }

          const txTimestamp = Number(transaction.timestampMs);
          if (txTimestamp < startTime || txTimestamp > endTime) continue;

          // Collect events from this transaction
          for (const event of processTransaction(transaction, poolId)) {
            allEvents.push(event);
          }
        }
      } catch (fileError) {
        console.error(`Error processing file ${file}:`, fileError);
        // Continue with next file
      }
    }

    // Sort all events by timestamp
    allEvents.sort((a, b) => {
      if (a.timestampMs !== b.timestampMs) {
        return a.timestampMs - b.timestampMs;
      }
      // If timestamps are equal, sort by digest then sequence
      if (a.digest !== b.digest) {
        return a.digest.localeCompare(b.digest);
      }
      return (a.seq ?? 0) - (b.seq ?? 0);
    });

    console.log(
      `Fetched and sorted ${allEvents.length} events for pool ${poolId} ` +
        `(time range: ${new Date(startTime).toISOString()} to ${new Date(
          endTime
        ).toISOString()})`
    );

    // Yield sorted events
    for (const event of allEvents) {
      yield event;
    }
  } catch (dirError) {
    console.error(`Error reading directory ${dataDir}:`, dirError);
    throw dirError;
  }
}

function* processTransaction(
  transaction: any,
  poolId: string
): IterableIterator<SwapEvent> {
  const digest = transaction.digest;
  const timestampMs = Number(transaction.timestampMs);

  // Handle both file and DB event structures
  const events = transaction.events || [];

  for (const event of events) {
    try {
      const seq = event.id?.eventSeq;
      const parsedJson = event.parsedJson;

      // Check event type - could be in event.type or parsedJson.type
      const eventType = event.type || parsedJson?.type;

      if (eventType === SwapEventId && parsedJson?.pool_id === poolId) {
        // Validate required fields exist
        if (
          !parsedJson.amount_x ||
          !parsedJson.amount_y ||
          !parsedJson.sqrt_price_before ||
          !parsedJson.sqrt_price_after ||
          parsedJson.x_for_y === undefined ||
          !parsedJson.fee_amount ||
          !parsedJson.reserve_x ||
          !parsedJson.reserve_y ||
          !parsedJson.tick_index?.bits
        ) {
          console.warn(`Skipping incomplete swap event in tx ${digest}`);
          continue;
        }

        const zeroForOne = Boolean(parsedJson.x_for_y);

        // Correct amount mapping based on swap direction
        const amountIn = zeroForOne
          ? BigInt(parsedJson.amount_x)
          : BigInt(parsedJson.amount_y);
        const amountOut = zeroForOne
          ? BigInt(parsedJson.amount_y)
          : BigInt(parsedJson.amount_x);

        const sqrtPriceBeforeX64 = BigInt(parsedJson.sqrt_price_before);
        const sqrtPriceAfterX64 = BigInt(parsedJson.sqrt_price_after);
        const fee = BigInt(parsedJson.fee_amount);
        const protocolFee = BigInt(parsedJson.protocol_fee || 0);
        const reserve0 = BigInt(parsedJson.reserve_x);
        const reserve1 = BigInt(parsedJson.reserve_y);
        const tick = Number(parsedJson.tick_index.bits);

        yield {
          timestampMs,
          digest,
          seq,
          amountIn,
          amountOut,
          sqrtPriceBeforeX64,
          sqrtPriceAfterX64,
          zeroForOne,
          fee,
          protocolFee,
          reserve0,
          reserve1,
          tick,
        };
      }
    } catch (error) {
      console.warn(`Error processing event in tx ${digest}:`, error);
      // Continue processing other events
    }
  }
}

export { importEvents, type ImportOptions };
