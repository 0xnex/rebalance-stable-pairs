#!/usr/bin/env bun

import { importEvents, loadPoolFromState } from "./src/event_importer.js";
import { Pool } from "./src/pool.js";

async function exampleDumpAndLoad() {
  const poolId =
    "0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9";
  const dumpTimestamp = 1760280000000; // Example timestamp to dump at
  const dumpPath = `./pool_state_${poolId}_${dumpTimestamp}.json`;

  console.log("🚀 Starting event import with state dumping...");

  // Import events and dump state at specified timestamp
  const pool = await importEvents(poolId, Date.now(), undefined, {
    dataDir: "./snapshots", // or your data directory
    dumpStateAt: dumpTimestamp,
    dumpStatePath: dumpPath,
    silent: false,
  });

  console.log("✅ Event import completed!");
  console.log(`📊 Final pool state:`, {
    reserveA: pool.reserveA.toString(),
    reserveB: pool.reserveB.toString(),
    sqrtPriceX64: pool.sqrtPriceX64.toString(),
    liquidity: pool.liquidity.toString(),
    tickCurrent: pool.tickCurrent,
    price: pool.price,
  });

  // Now demonstrate loading the pool from the dumped state
  console.log("\n🔄 Loading pool from dumped state...");

  try {
    const loadedPool = loadPoolFromState(dumpPath);

    console.log("✅ Pool loaded successfully from state file!");
    console.log(`📊 Loaded pool state:`, {
      reserveA: loadedPool.reserveA.toString(),
      reserveB: loadedPool.reserveB.toString(),
      sqrtPriceX64: loadedPool.sqrtPriceX64.toString(),
      liquidity: loadedPool.liquidity.toString(),
      tickCurrent: loadedPool.tickCurrent,
      price: loadedPool.price,
    });

    // Verify the loaded pool matches the original
    const statesMatch =
      pool.reserveA === loadedPool.reserveA &&
      pool.reserveB === loadedPool.reserveB &&
      pool.sqrtPriceX64 === loadedPool.sqrtPriceX64 &&
      pool.liquidity === loadedPool.liquidity &&
      pool.tickCurrent === loadedPool.tickCurrent;

    console.log(
      `🔍 State verification: ${statesMatch ? "✅ PASSED" : "❌ FAILED"}`
    );
  } catch (error) {
    console.error("❌ Failed to load pool from state:", error);
  }
}

// Run the example
exampleDumpAndLoad().catch(console.error);
