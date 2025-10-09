// backtest.ts

import * as fs from 'fs';
import * as path from 'path';

type Address = `0x${string}`;
const R = 1.0001;
const Q64 = 1n << 64n;
const Q128 = 1n << 128n;

// ===== CLI =====
const argv = Object.fromEntries(
  process.argv.slice(2)
    .map((v, i, a) => v.startsWith('--') ? [v.slice(2), (a[i+1]?.startsWith('--') || a[i+1]==null) ? '1' : a[i+1]] : [])
    .filter(Boolean)
);


enum EventType {
  Swap = 'SwapEvent',
  AddLiquidity = 'AddLiquidityEvent',
  RemoveLiquidity = 'RemoveLiquidityEvent',
  RepayFlashSwap = 'RepayFlashSwapEvent'
}

const EventTypes: Record<EventType, string> = {
  [EventType.Swap]: '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::trade::SwapEvent',
  [EventType.AddLiquidity]: '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::liquidity::AddLiquidityEvent',
  [EventType.RemoveLiquidity]: '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::liquidity::RemoveLiquidityEvent',
  [EventType.RepayFlashSwap]: '0x70285592c97965e811e0c6f98dccc3a9c2b4ad854b3594faab9597ada267b860::trade::RepayFlashSwapEvent'
}

const IN_DIR     = (argv['inDir']  ?? './data') as string;
const OUT_FILE   = (argv['out']    ?? './out/snapshots.csv') as string;
const POOL_ID    = (argv['poolId'] ?? '') as string;
const STEP_SEC   = Number(argv['step']   ?? 5);
const VOL_WIN    = Number(argv['volWin'] ?? 10);
const FEE_RATE   = Number(argv['feeRate'] ?? 1e-5);
const PROTO_BPS  = Number(argv['protocolFeeBps'] ?? 0);

if (!POOL_ID) {
  console.error('[ERR] --poolId required --poolId 0xabc...');
  process.exit(1);
}

// ===== Input Structure =====
interface MomentumBlock {
  timestampMs: string; // ms string
  digest: string;
  checkpoint: string;
  events: Array<MomentumEvent>;
}

type FlatEv =
  | { ts: number; poolId: Address; kind: 'swap';
      tickAfter?: number; sqrtAfter?: string;
      xForY?: boolean;
      amountX?: string | number; amountY?: string | number;
      amountIn0?: string | number; amountIn1?: string | number;
      feeAmount?: string | number; protocolFee?: string | number;
      liquidityAfter?: string | number;
    }
  | { ts: number; poolId: Address; kind: 'mint' | 'burn';
      tickLower: number; tickUpper: number; liquidityDelta: bigint
    };

interface Snapshot {
  ts: number;
  price: number;
  tick: number;
  activeL: bigint;
  feeGlobal0: bigint; feeGlobal1: bigint;
  volUsdPerMin: number;
}

type TxList = {
  cursor: string,
  nextCursor: string | null,
  data: MomentumBlock[]
}

type MomentumEvent = {
  id : {
    txDigest: string;
    eventSeq: number;
  };
  type: string;
  sender: Address;
  parsedJson: any;
};

/**
 "amount_x": "17319",
  "amount_y": "5643361365",
  "fee_amount": "28",
  "liquidity": "223153317804",
  "pool_id": "0x9d1878f9a0883679d1f122c66ac922517a2b11673db161d8820c5aacd83750f9",
  "protocol_fee": "7",
  "reserve_x": "14285894",
  "reserve_y": "14149931179511",
  "sender": "0xbd66f8010697ef45b1525e7e29ba63bf013d3641b8bdb931eee7037e9f119499",
  "sqrt_price_after": "10540395662409781591834",
  "sqrt_price_before": "10540862165188483291184",
  "tick_index": { "bits": 126967 },
  "x_for_y": true
 */

type MMTSwapEvent = {
  pool_id: Address;
  tick_index: { bits: number };
  sqrt_price_after: string;
  sqrt_price_before: string;
  x_for_y: boolean;
  amount_x: string ;
  amount_y: string ;
  fee_amount: string;
  protocol_fee: string;
  sender: string;
  liquidity: string;
  reserve_x: string;
  reserve_y: string;
}


/**
 * "amount_x": "4721251",
    "amount_y": "3951616",
    "liquidity": "9639451503",
    "lower_tick_index": { "bits": 4294967294 },
    "pool_id": "0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9",
    "position_id": "0x572de57fd751c90a0e3c60f22022442ec4068bc3111f231bfce5c9b8654a0281",
    "reserve_x": "4721251",
    "reserve_y": "3951616",
    "sender": "0x1453ca181ac472fcd07c408b94b302c5d300f926df95cdba0338f69a82fe375b",
    "upper_tick_index": { "bits": 16 }
 */
type MMTAddLiquidityEvent = {
  pool_id: Address;
  position_id: Address;
  lower_tick_index: { bits: number };
  upper_tick_index: { bits: number };
  liquidity: string;
  sender: Address;
  amount_x: string;
  amount_y: string;
  reserve_x: string;
  reserve_y: string;
}

/**
 *  "amount_x": "4068941",
            "amount_y": "6248390",
            "liquidity": "51588434224",
            "lower_tick_index": { "bits": 4 },
            "pool_id": "0x737ec6a4d3ed0c7e6cc18d8ba04e7ffd4806b726c97efd89867597368c4d06a9",
            "position_id": "0xa6dd535e7ac2ea852ae10d5e02556afac9d8a313417b0cc36aa8387b1741454d",
            "reserve_x": "63789258421",
            "reserve_y": "96684621939",
            "sender": "0x71ffcb9fb2bf28fd844fa5f48612ac2e7c68a3f64da609b7a52bfc77527ac220",
            "upper_tick_index": { "bits": 8 }
 */
type MMTRemoveLiquidityEvent = MMTAddLiquidityEvent;
 
// ===== tools =====
function priceFromSqrtQ64(s: string): number {
  const sqrt = BigInt(s);
  // sqrt(price) = sqrtQ64 / 2^64
  const ratio = Number(sqrt) / Number(Q64);
  return ratio * ratio;
}
function tickFromPrice(p: number): number {
  return Math.floor(Math.log(p) / Math.log(R));
}
function tickFromSqrtQ64(sqrtQ64: string): number {
  const p = priceFromSqrtQ64(sqrtQ64);
  return tickFromPrice(p);
}
function parseTickBits(bits: number | string): number {
  const u = typeof bits === 'string' ? Number(bits) : bits;
  return (u & 0x80000000) ? (u - 0x1_0000_0000) : u;
}
function reqNum(v: any, name: string): number {
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`Invalid ${name}: ${v}`);
  return n;
}
function numOrUndef(v: any): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function toBigIntLoose(v: any): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'string') return BigInt(v);
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  return BigInt(String(v ?? '0'));
}
function mulFrac(amount: bigint, rate: number): bigint {
  const SCALE = 1_000_000_000_000n;
  const r = BigInt(Math.round(rate * Number(SCALE)));
  return (amount * r) / SCALE;
}


// ===== 加载并“只筛选这个 poolId”扁平事件 =====
function loadAndFlattenForPool(dir: string, poolWanted: string): FlatEv[] {
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.json')).sort();
  const flat: FlatEv[] = [];

  for (const f of files) {
    const p = path.join(dir, f);
    let data: TxList;
    try {
      data = JSON.parse(fs.readFileSync(p, 'utf-8')) as TxList;
    } catch { continue; }

    for (const blk of data.data) {
      const baseTs = Number(blk.timestampMs);
      for (const ev of blk.events) {
        const t = (ev.type || '').toLowerCase();
        const j = ev.parsedJson || {};
        const poolId: Address = j.pool_id! as Address;
        if (!poolId || poolId.toLowerCase() !== poolWanted.toLowerCase()) continue;
        console.log('evt', ev)
        // --- SwapEvent ---
        if (t === MMTSwapEvent) {
          const evt = j as MMTSwapEvent;
          let amountIn0 = 0;
          let amountIn1 = 0;
          if (evt.x_for_y) {
            amountIn0 = reqNum(evt.amount_x, 'amountX');
          } else {
            amountIn1 = reqNum(evt.amount_y, 'amountY');
          }
          
          flat.push({
            ts: baseTs, 
            poolId, 
            kind: 'swap',
            tickAfter: parseTickBits(evt.tick_index.bits), 
            sqrtAfter: evt.sqrt_price_after, 
            xForY: evt.x_for_y,
            amountX: evt.amount_x, 
            amountY: evt.amount_y, 
            amountIn0, 
            amountIn1,
            feeAmount: evt.fee_amount, 
            protocolFee: evt.protocol_fee, 
            liquidityAfter: evt.liquidity
          });

        // --- AddLiquidityEvent → mint ---
        } else if (t === MMTAddLiquidityEvent) {
          const evt = j as MMTAddLiquidityEvent;
          const lower = parseTickBits(evt.lower_tick_index.bits);
          const upper = parseTickBits(evt.upper_tick_index.bits);
          const deltaL = toBigIntLoose(j.liquidity); // ΔL > 0
          flat.push({
            ts: baseTs, 
            poolId, 
            kind: 'mint', 
            tickLower: lower, 
            tickUpper: upper, 
            liquidityDelta: deltaL 
          });
        // --- RemoveLiquidityEvent → burn ---
        } else if (t === MMTRemoveLiquidityEvent){
          const evt = j as MMTAddLiquidityEvent;
          const lower = parseTickBits(evt.lower_tick_index.bits);
          const upper = parseTickBits(evt.upper_tick_index.bits);
          const deltaL = -toBigIntLoose(j.liquidity); // ΔL > 0
          flat.push({
            ts: baseTs, 
            poolId, 
            kind: 'mint', 
            tickLower: lower, 
            tickUpper: upper, 
            liquidityDelta: deltaL 
          });

        // --- RepayFlashSwapEvent：忽略 ---
        } else if (t.includes('::trade::repayflashswapevent')) {
          continue;

        } else {
          // 其他事件不影响回放，忽略
        }
      }
    }
  }

  flat.sort((a,b) => a.ts - b.ts);
  return flat;
}

// ===== Pool 回放状态（单池） =====
interface TickState { feeOutside0: bigint; feeOutside1: bigint; }
class PoolReplay {
  currentTick: number = 0;
  activeL: bigint = 0n;
  feeGlobal0: bigint = 0n;
  feeGlobal1: bigint = 0n;
  liqNet = new Map<number, bigint>();
  ticks = new Map<number, TickState>();
  volBuf: Array<{ts:number; usd:number}> = [];

  getTickState(t: number): TickState {
    let s = this.ticks.get(t);
    if (!s) { s = { feeOutside0: 0n, feeOutside1: 0n }; this.ticks.set(t, s); }
    return s;
  }
  crossTick(t: number) {
    const s = this.getTickState(t);
    s.feeOutside0 = this.feeGlobal0 - s.feeOutside0;
    s.feeOutside1 = this.feeGlobal1 - s.feeOutside1;
  }
  applyMintBurn(lower: number, upper: number, delta: bigint) {
    this.liqNet.set(lower, (this.liqNet.get(lower) ?? 0n) + delta);
    this.liqNet.set(upper, (this.liqNet.get(upper) ?? 0n) - delta);
    const t = this.currentTick;
    if (t >= lower && t < upper) this.activeL += delta;
  }
  moveTick(newTick: number) {
    const prev = this.currentTick;
    if (newTick === prev) return;
    if (newTick > prev) {
      for (let t = prev + 1; t <= newTick; t++) {
        this.crossTick(t);
        this.activeL += (this.liqNet.get(t) ?? 0n);
      }
    } else {
      for (let t = prev; t > newTick; t--) {
        this.crossTick(t);
        this.activeL -= (this.liqNet.get(t) ?? 0n);
      }
    }
    this.currentTick = newTick;
  }
  feeStep(tokenIn: 0|1, feeLPs: bigint) {
    if (this.activeL <= 0n || feeLPs <= 0n) return;
    const deltaQ = (feeLPs * Q128) / this.activeL;
    if (tokenIn === 0) this.feeGlobal0 += deltaQ; else this.feeGlobal1 += deltaQ;
  }
}

// ===== 回放（单池）=====
function backfillSinglePool(flat: FlatEv[], opts: { stepSec: number; volWinMin: number; feeRate: number; protocolFeeBps: number }): Snapshot[] {
  if (flat.length === 0) return [];
  const stepMs = Math.max(1, opts.stepSec) * 1000;
  const t0 = flat[0].ts, t1 = flat[flat.length - 1].ts;

  const pool = new PoolReplay();

  // 初始化 currentTick（用第一条能解析出的价格）
  for (const e of flat) {
    if (e.kind === 'swap') {
      const t = e.tickAfter ?? (e.sqrtAfter ? tickFromSqrtQ64(String(e.sqrtAfter)) : undefined);
      if (t != null) { pool.currentTick = t; break; }
    }
  }

  const snaps: Snapshot[] = [];
  let i = 0;

  for (let ts = Math.floor(t0/stepMs)*stepMs; ts <= t1 + stepMs; ts += stepMs) {
    while (i < flat.length && flat[i].ts <= ts) {
      const e = flat[i];

      if (e.kind === 'mint' || e.kind === 'burn') {
        pool.applyMintBurn(e.tickLower, e.tickUpper, e.liquidityDelta);

      } else if (e.kind === 'swap') {
        // --- 1) 计算“给LP的手续费” ---
        // 优先使用事件提供的 fee_amount（更权威）；没有则回退 amountIn * feeRate * (1 - proto)
        const tokenIn: 0|1 =
          e.xForY === true  ? 0 :
          e.xForY === false ? 1 :
          // 兜底：谁绝对值更大就当输入
          (Math.abs(Number(e.amountX ?? 0)) >= Math.abs(Number(e.amountY ?? 0)) ? 0 : 1);

        let feeLPs = toBigIntLoose(e.feeAmount ?? 0);
        if (feeLPs === 0n) {
          const amountIn =
            tokenIn === 0
              ? toBigIntLoose(e.amountIn0 ?? e.amountX ?? 0)
              : toBigIntLoose(e.amountIn1 ?? e.amountY ?? 0);
          const feeGross = mulFrac(amountIn, opts.feeRate);
          const feeProto = (toBigIntLoose(e.protocolFee ?? 0) > 0n)
            ? toBigIntLoose(e.protocolFee)
            : (feeGross * BigInt(opts.protocolFeeBps)) / 10_000n;
          feeLPs = feeGross - feeProto;
          if (feeLPs < 0n) feeLPs = 0n;
        }

        // --- 2) 可用事件携带的 liquidity 覆盖 activeL（如存在）
        if (e.liquidityAfter != null) {
          const Lafter = toBigIntLoose(e.liquidityAfter);
          if (Lafter > 0n) pool.activeL = Lafter;
        }

        // --- 3) 计入 feeGrowthGlobal{tokenIn} ---
        pool.feeStep(tokenIn, feeLPs);

        // --- 4) 成交量统计（稳定币近似 |X|+|Y|）---
        const ax = Math.abs(Number(e.amountX ?? 0));
        const ay = Math.abs(Number(e.amountY ?? 0));
        const volUsd = ax + ay;
        if (volUsd > 0) pool.volBuf.push({ ts: e.ts, usd: volUsd });

        // --- 5) 价格/跨tick ---
        const newTick = e.tickAfter ?? (e.sqrtAfter ? tickFromSqrtQ64(String(e.sqrtAfter)) : pool.currentTick);
        if (newTick != null && newTick !== pool.currentTick) pool.moveTick(newTick);
      }

      i++;
    }

    // 滚动成交量/分钟
    const horizon = opts.volWinMin * 60_000;
    while (pool.volBuf.length && ts - pool.volBuf[0].ts > horizon) pool.volBuf.shift();
    const volSum = pool.volBuf.reduce((a,b)=>a+b.usd, 0);
    const volPerMin = volSum / Math.max(1, opts.volWinMin);

    const price = Math.pow(R, pool.currentTick);
    snaps.push({
      ts, price,
      tick: pool.currentTick,
      activeL: pool.activeL,
      feeGlobal0: pool.feeGlobal0, feeGlobal1: pool.feeGlobal1,
      volUsdPerMin: volPerMin,
    });

    if (ts > t1 && i >= flat.length) break;
  }
  return snaps;
}

// ===== 写CSV =====
function writeCSV(snaps: Snapshot[], out: string) {
  const header = 'ts,price,tick,activeL,feeGlobal0,feeGlobal1,vol_usd_per_min\n';
  const lines = snaps.map(s => `${s.ts},${s.price.toFixed(12)},${s.tick},${s.activeL.toString()},${s.feeGlobal0.toString()},${s.feeGlobal1.toString()},${s.volUsdPerMin.toFixed(6)}`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, header + lines.join('\n'));
  console.log(`[OK] ${snaps.length} snapshots → ${out}`);
}

// ===== main =====
function main() {
  if (!fs.existsSync(IN_DIR)) {
    console.error(`[ERR] inDir not found: ${IN_DIR}`);
    process.exit(1);
  }
  const flat = loadAndFlattenForPool(IN_DIR, POOL_ID);
  if (flat.length === 0) {
    console.error('[ERR] 没有匹配该 poolId 的事件，检查 --poolId 或数据目录');
    process.exit(1);
  }
  const snaps = backfillSinglePool(flat, {
    stepSec: STEP_SEC, volWinMin: VOL_WIN, feeRate: FEE_RATE, protocolFeeBps: PROTO_BPS
  });
  writeCSV(snaps, OUT_FILE);
}

main();
