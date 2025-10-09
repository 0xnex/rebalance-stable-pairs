# Test Suite

This directory contains comprehensive tests for the rebalance-stable-pairs project using Bun's built-in test framework.

## Test Structure

- `virtual_position_mgr.test.ts` - Tests for the VirtualPositionManager multi-position functionality
- `run_tests.ts` - Test runner script using Bun's test framework

## Running Tests

### Run All Tests (Recommended)

```bash
bun test tests/
```

### Run All Tests with Test Runner

```bash
bun run tests/run_tests.ts
```

### Run Specific Test File

```bash
bun test tests/virtual_position_mgr.test.ts
```

### Run Tests with Coverage

```bash
bun test --coverage tests/
```

### Run Tests in Watch Mode

```bash
bun test --watch tests/
```

## Test Coverage

### VirtualPositionManager Tests

The VirtualPositionManager test suite covers:

1. **Basic Multi-Position Support**

   - Creating multiple positions
   - Managing position collections
   - Basic CRUD operations

2. **Position Filtering and Querying**

   - Active vs inactive position filtering
   - Range-based filtering
   - Liquidity threshold filtering
   - Time-based filtering

3. **Bulk Operations**

   - Bulk position creation
   - Bulk position updates
   - Bulk position removal
   - Bulk fee collection

4. **Position Analytics**

   - Comprehensive position analytics
   - Performance metrics calculation
   - Risk metrics calculation
   - Summary reports

5. **Position Sorting**

   - Sorting by various criteria (liquidity, amounts, creation time, fees)
   - Ascending and descending order support

6. **Criteria-Based Filtering**

   - Multi-criteria filtering
   - Complex query combinations
   - Result validation

7. **Position Management**

   - Individual position updates
   - Fee calculations and collection
   - Position value calculations

8. **Totals and Summary**
   - Portfolio totals
   - Clear all operations

## Adding New Tests

To add a new test file:

1. Create a new test file following the pattern `*.test.ts`
2. Use Bun's test framework with `describe`, `it`, `expect`, and `beforeEach`
3. Import the necessary modules and test utilities

Example test file structure:

```typescript
import { describe, it, expect, beforeEach } from "bun:test";

describe("MyComponent", () => {
  beforeEach(() => {
    // Setup for each test
  });

  it("should do something", () => {
    // Test implementation
    expect(something).toBe(expected);
  });
});
```

## Test Best Practices

1. **Isolation**: Each test should be independent and not rely on other tests
2. **Setup**: Use `beforeEach` to set up clean state for each test
3. **Assertions**: Use Bun's `expect` assertions for clear test validation
4. **Descriptive Names**: Use clear, descriptive test names that explain what is being tested
5. **Error Handling**: Test both success and failure scenarios
6. **Documentation**: Include clear test descriptions and expected behavior

## Bun Test Framework Features

- **Fast Execution**: Bun's test runner is optimized for speed
- **Built-in Assertions**: Rich set of assertion methods with `expect`
- **Watch Mode**: Automatic re-running of tests when files change
- **Coverage Reports**: Built-in code coverage analysis
- **Parallel Execution**: Tests run in parallel by default for better performance
- **TypeScript Support**: Full TypeScript support out of the box

## Continuous Integration

These tests are designed to be run in CI/CD pipelines. The test runner exits with:

- Exit code 0: All tests passed
- Exit code 1: One or more tests failed

## Performance Considerations

- Tests use realistic but small data sets to ensure fast execution
- Bulk operations are tested with reasonable batch sizes
- Memory usage is kept minimal for CI environments
- Tests are designed to run in parallel for optimal performance
