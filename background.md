# Background Notes

## Project Overview
- **Purpose:** backtest a Sui CLMM (Concentrated Liquidity Market Maker) by replaying archived on-chain events.
- **Primary entry points:**
  - `src/event_importer.ts` – reads momentum event archive (`../mmt_txs/<poolId>/page_*.json`), replays pool state, and validates swaps.
  - `src/pool.ts` – CLMM engine used for replay and strategy simulations.
  - `dump_pool_to_2025-08-25.ts` – CLI helper that replays events up to 2025‑08‑25 and dumps a snapshot under `./dumps/`.
- `compare_last_swap.ts` – script to compare the importer’s reconstructed pool state against the final on-chain swap prior to 2025‑08‑25.
- `src/virtual_position_mgr.ts` – manager that tracks strategy “virtual” positions, their token balances, fee accrual, and swap capacity estimates without mutating pool state.
- `src/backtest_engine.ts` – reusable engine that replays events second-by-second, drives strategies, and keeps pool state in sync with on-chain data.
- `src/backtest_runner.ts` – CLI wrapper that wires config/strategy modules into the engine.
- `src/strategies/noop_strategy.ts` – example strategy that demonstrates the required factory signature.
- `src/strategies/simple_rebalance_strategy.ts` – reusable ±0.01% range keeper (configurable) with cooldown/timeout controls and the ability to consume strategy-managed cash balances.
- `src/strategies/simple_rebalance_backtest.ts` – wraps the simple rebalance logic in the backtest `strategyFactory`; honors optional env overrides (`SIMPLE_INITIAL_A/B`, `SIMPLE_PRICE_RANGE`, `SIMPLE_TIMEOUT_MS`, `SIMPLE_COOLDOWN_MS`, `SIMPLE_MAX_REBALANCES`) and now refreshes virtual position fee accrual on every tick/event so performance totals capture earned fees.
- `src/strategies/adaptive_fee_rebalancer_strategy.ts` – adaptive range keeper that widens or narrows its tick band based on fee growth trends, price drift, and configurable cooldowns while accounting for per-action costs; bootstraps the first position with configurable range/slippage retries so it can provision liquidity even when starting from a single-sided balance.
- `src/strategies/adaptive_fee_rebalancer_backtest.ts` – strategy factory exposing environment-driven controls (initial balances, fee targets, slippage, action costs) and coalesced logging for the adaptive rebalancer.
- `src/strategies/three_band_rebalancer_strategy.ts` – multi-band liquidity scheduler tuned for near-parity pairs: supports arbitrary contiguous micro-bands (default 5 × 0.001%), runs fast interval checks on the closest bands, slower cadence on outer bands, enforces a minimum dwell and out-of-range duration, and only rotates when the accrued fees exceed the estimated rotation cost (configurable profit guard).
- `src/strategies/three_band_rebalancer_backtest.ts` – backtest wiring for the three-band strategy; `THREEBAND_*` environment variables control initial balances, band count/width, fast & slow intervals, minimum dwell, slippage, and action costs.
- `src/three_band_grid.ts` – parameter-grid harness that sweeps the three-band configuration space (band count, width, fast/slow cadence, dwell, slippage, action costs, initial balances) and prints the top-performing combinations.

## Data Locations
- Event JSON pages live at `../mmt_txs/<poolId>/page_XXXX.json` (outside repo root).
- `importEvents` expects those files and a `poolId`. The `--inDir` option on `src/backtest.ts` can point at this directory if needed.

## Key Implementation Details
- `event_importer.ts`
  - Correctly interprets `x_for_y`; swap direction determines which token amount is treated as input/output.
  - Before validating each swap, the importer seeds the pool with the event’s `sqrt_price_before`, `liquidity`, and reserves to match on-chain state.
  - Liquidity add/remove events refresh cached liquidity/reserves after applying deltas.
- `pool.ts`
  - Tracks raw fee rate in ppm (basis of 1e6) and splits fees as: `fee = ceil(amount * rate); lpFee = max(ceil(fee * 0.8), 1); protocolFee = max(fee - lpFee, 0)`.
  - Swap math: zero-for-one branch uses the exact Q64 rational form `newSqrt = L·sqrt·Q64 / (L·Q64 + Δin·sqrt)` to avoid ±1 drift; one-for-zero branch uses symmetric formula.
  - `applySwapWithValidation` reuses event-provided `fee_amount` / `protocol_fee` when available for exact replay.
  - Delegates virtual-position management to `VirtualPositionManager`, keeping pool state isolated from strategy bookkeeping.
- `virtual_position_mgr.ts`
  - Maintains per-position state (`amountA`, `amountB`, liquidity, fee checkpoints, tokens owed) and exposes aggregate summaries.
  - Provides dry-run helpers (estimate create/add/remove/collect, value, max swap under slippage) that never mutate internal or pool state.
  - Offers actual actions (`createPosition`, `updatePosition`, `collectFees`, `recordSwap`, `removePosition`, etc.) that mutate manager state only.
  - Uses pool-provided analytics (fee growth, liquidity math, swap estimates) to keep calculations consistent with replay logic.
  - Supplies `getTotals()` for quick portfolio snapshots across all tracked positions.
  - Supports cash management via `setInitialBalances` and `openPosition`, which consumes cash balances and returns usage/refund/slippage (gas fee currently placeholder).
  - `updateAllPositionFees()` snapshots current fee growth and updates `tokensOwed{0,1}`; call this after pool fee growth changes (the simple rebalance factory now does this automatically during backtests).
  - Tracks `collectedFees{0,1}` as fees are realized (either via explicit `collectFees` or when positions are removed), so backtest summaries expose both pending (`feesOwed`) and realized fee income.
  - `addLiquidityWithSwap()` can rebalance token holdings via virtual swaps (bounded by a max slippage threshold) before opening a position, returning liquidity plus remaining token balances.
  - Action costs (e.g., gas) can be recorded via optional `{tokenA, tokenB}` amounts; totals surface through `totalCostTokenA/B` in `getTotals()`.
- `backtest_engine.ts`
  - Seeds pool state via `importEvents`, loads relevant momentum events, and steps the simulation clock at configurable intervals (default 1s).
  - Applies swap/add/remove events to the pool as they occur, updating the linked `VirtualPositionManager` fee accrual and invoking strategy hooks per tick/event while keeping the strategy state isolated from pool state.
  - Returns a summary report (ticks processed, events consumed, portfolio totals) plus performance metrics (initial/final value, absolute & % return, max drawdown, sampled equity curve). Set `metricsIntervalMs` on `BacktestConfig` (default 60 s) to control sampling cadence.
- `backtest_runner.ts`
  - CLI entry point: `bun run src/backtest_runner.ts --poolId ... --start ... --end ... --strategy ./path/to/strategy.ts` (optional `--dataDir`, `--step`).
  - Dynamically loads the strategy factory and prints the engine report as JSON.
- `event_importer.ts`
  - `importEvents(poolId, until, eventTypes?, { silent, dataDir })` now accepts an optional `dataDir` override so backtests can seed state from custom archives while suppressing console noise with `silent`.
  
### Example Backtest Runs

- No-op smoke test:
  ```bash
  bun run src/backtest_runner.ts \
    --poolId 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 \
    --start "2025-08-24T23:56:00Z" \
    --end "2025-08-24T23:58:00Z" \
    --step 1000 \
    --strategy ./src/strategies/noop_strategy.ts \
    --dataDir ../mmt_txs/0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9
  ```

- Simple rebalance (10-day window, 1-second steps):
  ```bash
  SIMPLE_INITIAL_A=100000 SIMPLE_INITIAL_B=200000 \
  bun run src/backtest_runner.ts \
    --poolId 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 \
    --start "2025-08-20T00:00:00Z" \
    --end "2025-08-30T00:00:00Z" \
    --step 1000 \
    --strategy ./src/strategies/simple_rebalance_backtest.ts \
    --dataDir ../mmt_txs/0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9
  ```
  - Latest run (with `addLiquidityWithSwap`) realised `collectedFees0=1194`, `collectedFees1=1588`, no pending fees, and ~0.91 % portfolio gain over Aug 20–30.
  - Example with 10 000 USDC start, ±0.01 % range, and `SIMPLE_ACTION_COST_B=0.01` nets ≈60 USDC (0.60 %), realised fees `18/25`, and accumulates total cost `0.05` USDC.
- Three-band (parity stable pair focus):
  ```bash
  THREEBAND_INITIAL_A=5000 THREEBAND_INITIAL_B=5000 \
  THREEBAND_SEGMENT_COUNT=5 THREEBAND_RANGE_PERCENT=0.001 \
  THREEBAND_FAST_COUNT=2 THREEBAND_FAST_INTERVAL_MS=30000 \
  THREEBAND_SLOW_INTERVAL_MS=300000 THREEBAND_MIN_DWELL_MS=120000 \
  THREEBAND_MAX_SLIPPAGE_BPS=10 THREEBAND_ACTION_COST_B=0.02 \
  bun run src/backtest_runner.ts \
    --poolId 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 \
    --start "2025-08-20T00:00:00Z" \
    --end "2025-09-01T00:00:00Z" \
    --step 1000 \
    --strategy ./src/strategies/three_band_rebalancer_backtest.ts \
    --dataDir ../mmt_txs/0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9
  ```
  - Recent run collected `18 / 26` pending fees (token A/B) with total cost `0.24` in token B and returned ~0.38 % over 12 days, showing smoother fee accrual but slower capital rotation compared to the three-band aggressive variant.
  - Latest rerun (start 2025-08-21→end 2025-09-10, 1 s step) with `THREEBAND_INITIAL_B=10000000000` (≈$10 000 USDC at 6 decimals), three 0.001 % bands, 30 s/60 s cadence, 60 s dwell/out-of-range guards, `THREEBAND_ACTION_COST_B=0.02`, and `THREEBAND_MIN_PROFIT_B=0.02` delivered +0.698 % net; realised fees `collectedFees0=30863250` / `collectedFees1=41244059` (≈30.86/41.24 USDC) and debited total action cost `0.06` token B.
- Three-band grid sweep (示例)：支持 `THREEBAND_MIN_OUT_MS`、`THREEBAND_ROTATION_TICK_THRESHOLD`、`THREEBAND_MIN_PROFIT_B` 等成本保护参数
  ```bash
  bun run src/three_band_grid.ts \
    --poolId 0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9 \
    --start "2025-08-20T00:00:00Z" \
    --end "2025-09-01T00:00:00Z" \
    --rangePercents 0.0008,0.001,0.0012 \
    --segmentCounts 3,5 \
    --fastCounts 1,2 \
    --slowIntervals 60000,300000 \
    --minDwells 0,120000 \
    --initialAmountsA 5000 \
    --initialAmountsB 5000
  ```
  - 脚本会按 cartesian-product 组合逐个回测，输出每组配置的收益率、手续费与成本，并列出 Top N 结果，便于快速定位高收益参数区间。

## Current Validation Status
- With cost guards (min out-of-range duration, dwell time, tick threshold, profit check), the high-cost scenario (0.02 USDC per action, 2025-08-21→2025-09-10) produced +0.7867% over 20 days while recording only 0.006 USDC of action cost. Without guards the same run lost ~59%, highlighting the need to tune the `THREEBAND_*` guard parameters before mainnet deployment.

- Early swaps replay exactly (amount out & fee) after rounding fixes.
- Remaining mismatches arise on large trades that span multiple ticks; full tick-by-tick liquidity is not yet reconstructed, so crossing logic is incomplete.
- `compare_last_swap.ts` can be used to inspect the final swap before the target cutoff and compare to the importer state.

## Useful Commands
- Install deps: `bun install`
- Replay to snapshot: `bun run dump_pool_to_2025-08-25.ts`
- Compare final swap vs. pool replay: `bun run compare_last_swap.ts`
- Backtest CLI (custom dir): `bun run src/backtest.ts --poolId <POOL> --inDir ../mmt_txs/<POOL>`

## Next Steps / Open Items
- Implement full tick crossing by tracking per-tick liquidity deltas from positions. This is required to remove large-amount mismatches.
- Extend `compare_last_swap.ts` to report intermediate diagnostic data once tick state tracking is improved.
- Consider caching parsed event pages to speed up repeated replays.
