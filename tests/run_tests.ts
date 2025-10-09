#!/usr/bin/env bun

/**
 * Test runner using Bun's built-in test framework
 * This script runs all tests in the tests directory
 */

import { spawn } from "bun";

async function runTests(): Promise<void> {
  console.log("🧪 Running tests with Bun test framework...\n");

  try {
    // Run all test files in the tests directory
    const testProcess = spawn({
      cmd: ["bun", "test", "tests/"],
      stdio: ["inherit", "inherit", "inherit"],
    });

    const exitCode = await testProcess.exited;

    if (exitCode === 0) {
      console.log("\n🎉 All tests passed!");
      process.exit(0);
    } else {
      console.log(`\n⚠️ Tests failed with exit code ${exitCode}`);
      process.exit(exitCode);
    }
  } catch (error) {
    console.error("❌ Failed to run tests:", error);
    process.exit(1);
  }
}

// Run if this file is executed directly
if (import.meta.main) {
  runTests().catch((error) => {
    console.error("❌ Test runner failed:", error);
    process.exit(1);
  });
}
