/**
 * Raydium CLMM spread probe (single-pool, RPC-only, no routing).
 * - Pulls pool + tick arrays via @raydium-io/raydium-sdk-v2 (RPC)
 * - Computes BUY (USD->A exact-in) and SELL (A->USD exact-out) on THIS POOL ONLY
 * - Saves CSV with the unified schema (matching Orca)
 */

import { Connection, PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import Decimal from "decimal.js";
import { Raydium, PoolUtils } from "@raydium-io/raydium-sdk-v2";
import { mkCsvAppender } from "./csv.js";

// ---------- CLI ----------
type Args = {
  rpc: string;
  pool: string;
  sizes: string;
  range?: string;
  csv?: string;
  quiet: boolean;
};

function parseSizes(argvSizes: string, range?: string): number[] {
  if (range && range.includes(":")) {
    const [a, b, s] = range.split(":").map((x) => Number(x.trim()));
    if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(s) && s > 0) {
      const out: number[] = [];
      for (let v = a; v <= b; v += s) out.push(v);
      return out;
    }
  }
  return argvSizes.split(",").map((s) => Number(s.trim())).filter((n) => n > 0);
}

const argv = (() => {
  const out: Args = {
    rpc: "https://api.mainnet-beta.solana.com",
    pool: "",
    sizes: "5000,10000,15000,20000,25000,30000,35000,40000,45000,50000",
    range: "5000:50000:5000",
    csv: undefined,
    quiet: false,
  };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === "--rpc") out.rpc = a[++i];
    else if (k === "--pool") out.pool = a[++i];
    else if (k === "--sizes") out.sizes = a[++i];
    else if (k === "--range") out.range = a[++i];
    else if (k === "--csv") out.csv = a[++i];
    else if (k === "--quiet") out.quiet = true;
  }
  if (!out.pool) {
    console.error("Missing --pool <pubkey>");
    process.exit(1);
  }
  return out;
})();

const sizes = parseSizes(argv.sizes, argv.range);

// ---------- Constants & helpers ----------
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL = "So11111111111111111111111111111111111111112";
const Q64 = 2n ** 64n;

const fmtUSD = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;
const toBN = (amt: number, dec: number) => new BN(new Decimal(amt).mul(Decimal.pow(10, dec)).toFixed(0));
const bnToNumber = (bn: BN, dec: number) => new Decimal(bn.toString()).div(Decimal.pow(10, dec)).toNumber();

async function getMintDecimalsViaRPC(conn: Connection, mint: string): Promise<number> {
  if (mint === WSOL) return 9;
  if (mint === USDC) return 6;
  const info = await conn.getParsedAccountInfo(new PublicKey(mint));
  const dec = (info?.value as any)?.data?.parsed?.info?.decimals;
  return (typeof dec === "number") ? dec : 9;
}

// Convert on-chain sqrtPriceX64 -> price (tokenB per tokenA), adjusted for decimals.
// Return USD per BASE (non-USD side).
function midUsdPerBase_fromSqrt(
  sqrtPriceX64: BN,
  decA: number,
  decB: number,
  mintA: string,
  mintB: string
): number {
  const sqrt = new Decimal(sqrtPriceX64.toString());
  const ratio = sqrt.div(new Decimal(Q64.toString())); // real sqrtP
  const pxBperA = ratio.mul(ratio).mul(Decimal.pow(10, decA - decB)); // B per A
  const isUsdA = mintA === USDC;
  const isUsdB = mintB === USDC;
  if (isUsdB) return pxBperA.toNumber();              // USD per A (BASE=A)
  if (isUsdA) return new Decimal(1).div(pxBperA).toNumber(); // USD per B (BASE=B)
  return pxBperA.toNumber(); // if neither is USD, treat as quote per A
}

function normalizeFeePpm(raw: unknown): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n) || n === 0) return 0;
  if (n > 0 && n < 1) return Math.round(n * 1_000_000); // fraction -> ppm
  return Math.round(n); // already ppm
}

const MINT_SYMBOL: Record<string, string> = {
  So11111111111111111111111111111111111111112: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERZ8YK4QNoPgPOnTnKpXc9E8uCQbQax4y: "USDT",
};
const symbolForMint = (mint: string) => MINT_SYMBOL[mint] ?? "";

function extractTickArrayStartsUsed(rem: any, tickArrayCache: Record<string, any>): number[] {
  const candidates: any[] =
    rem?.tickArrayAccounts ??
    rem?.tickArrayKeys ??
    rem?.tickArrayAddresses ??
    rem?.accounts ??
    rem ??
    [];
  const toAddr = (x: any) =>
    x?.toBase58?.() ||
    x?.address?.toBase58?.() ||
    x?.pubkey?.toBase58?.() ||
    x?.address ||
    (typeof x === "string" ? x : null);

  const addrs = (Array.isArray(candidates) ? candidates : []).map(toAddr).filter(Boolean) as string[];
  if (addrs.length === 0) return [];

  const addrToStart: Record<string, number> = {};
  for (const [startStr, ta] of Object.entries(tickArrayCache)) {
    const addr =
      (ta as any)?.address?.toBase58?.() ||
      (ta as any)?.pubkey?.toBase58?.() ||
      (ta as any)?.id?.toBase58?.() ||
      (ta as any)?.address ||
      null;
    if (addr) addrToStart[String(addr)] = Number(startStr);
  }

  const starts = addrs.map((a) => addrToStart[a]).filter((n) => Number.isFinite(n)) as number[];
  return Array.from(new Set<number>(starts)).sort((a, b) => a - b);
}

// CSV header (aligned with Orca)
function csvHeader(): (string | number)[] {
  return [
    "ts_utc",
    "dex",
    "pool",
    "program_id",
    "tick_spacing",
    "fee_ppm",
    "fee_bps",
    "protocol_fee_ppm",
    "liquidity_u128",
    "sqrt_price_x64",
    "tick_current",
    "mintA","decA","symbolA",
    "mintB","decB","symbolB",
    "base_mint","base_decimals","base_symbol",
    "quote_mint","quote_decimals","quote_symbol",
    "usd_per_quote",
    "mid_usd_per_base",
    "usd_notional",
    "buy_px_usd_per_base",
    "sell_px_usd_per_base",
    "roundtrip_bps",
    "fee_bps_total",
    "impact_bps_total",
    "buy_out_base",
    "sell_in_base",
    "buy_fee_quote",
    "sell_fee_base",
  ];
}

// ---- type guard to ensure the fetched pool is a CLMM item (has `config`) ----
type MinimalClmmInfo = {
  id: string;
  programId: any;
  mintA: any;
  mintB: any;
  config: any;
  price: any;
};
function isConcentratedPool(p: any): p is MinimalClmmInfo {
  return p && "config" in p && "mintA" in p && "mintB" in p && "id" in p && "programId" in p && "price" in p;
}

// ---------- Main ----------
(async () => {
  if (!argv.quiet) {
    console.log("=== RAYDIUM_SPREADS (RPC single-pool) ===");
    console.log(`Pool=${argv.pool}`);
    console.log("Roundtrip results (USD-sized):");
    console.log("  Notional      Mid(USD/BASE)   BuyPx       SellPx      RT bps   Fee bps   Impact bps");
  }

  const conn = new Connection(argv.rpc, "confirmed");

  const raydium = await Raydium.load({
    connection: conn as any,          // type erase to avoid multi-web3.js mismatch
    disableFeatureCheck: true,
    disableLoadToken: true,
  });

  // Load pool metadata then compute-ready on-chain info
  const apiPools = await raydium.api.fetchPoolById({ ids: argv.pool });
  if (!apiPools?.length) {
    console.error("Fatal: pool not found via Raydium API metadata");
    process.exit(1);
  }
  const apiPool = apiPools[0];

  if (!isConcentratedPool(apiPool)) {
    throw new Error("Pool is not a CLMM (concentrated) pool or missing `config` field.");
  }

  // Build a minimal object with the exact keys the SDK expects
  const poolPick: MinimalClmmInfo = {
    id: apiPool.id,
    programId: apiPool.programId,
    mintA: apiPool.mintA,
    mintB: apiPool.mintB,
    config: apiPool.config,
    price: apiPool.price,
  };

  const clmmInfo = await PoolUtils.fetchComputeClmmInfo({
    connection: conn as any,
    poolInfo: poolPick as any,
  });

  // Tick arrays cache for this pool
  const taCacheMap = await PoolUtils.fetchMultiplePoolTickArrays({
    connection: conn as any,
    poolKeys: [clmmInfo],
  });
  const tickArrayCache: Record<string, any> = (taCacheMap as any)[argv.pool] || {};

  // Pool fields
  const programId =
    (apiPool as any).programId?.address ||
    (clmmInfo as any).programId?.toBase58?.() ||
    "UNKNOWN";

  const feePpm_one_leg = normalizeFeePpm((apiPool as any).feeRate ?? (clmmInfo as any).feeRate ?? 0);
  const protoFeePpm = normalizeFeePpm((apiPool as any).protocolFeeRate ?? (clmmInfo as any).protocolFeeRate ?? 0);
  const feeBps_one_leg = feePpm_one_leg / 100;
  const feeBps_total = feeBps_one_leg * 2;

  const tickSpacing = Number((apiPool as any).tickSpacing ?? (clmmInfo as any).tickSpacing ?? 0);
  const sqrtPriceX64: BN = (clmmInfo as any).sqrtPriceX64 ?? new BN(0);
  const tickCurrentIndex = Number((clmmInfo as any).tickCurrent ?? 0);
  const liquidity: BN = (clmmInfo as any).liquidity ?? new BN(0);

  const mintA =
    (apiPool as any).mintA?.address ||
    (clmmInfo as any).mintA?.mint?.toString?.() ||
    (clmmInfo as any).mintA?.toString?.();
  const mintB =
    (apiPool as any).mintB?.address ||
    (clmmInfo as any).mintB?.mint?.toString?.() ||
    (clmmInfo as any).mintB?.toString?.();

  const decA = await getMintDecimalsViaRPC(conn, mintA);
  const decB = await getMintDecimalsViaRPC(conn, mintB);

  const symbolA = symbolForMint(mintA);
  const symbolB = symbolForMint(mintB);

  const midUSDperBase = midUsdPerBase_fromSqrt(sqrtPriceX64, decA, decB, mintA, mintB);

  // base/quote identification (prefer USDC as quote)
  const isUsdA = mintA === USDC;
  const isUsdB = mintB === USDC;
  const quoteMint   = isUsdB ? mintB : isUsdA ? mintA : mintB;
  const quoteDecimals = (quoteMint === mintA) ? decA : decB;
  const quoteSymbol = symbolForMint(quoteMint);
  const baseMint  = isUsdB ? mintA : mintB;
  const baseDecs  = isUsdB ? decA  : decB;
  const baseSymbol = symbolForMint(baseMint);
  const usdPerQuote = (quoteMint === USDC) ? 1 : 1; // keep=1 unless you add oracle logic

  // CSV
  const csv = argv.csv ? mkCsvAppender(argv.csv) : null;
  if (csv) csv.write(csvHeader());

  // ---- Quote helpers (pool-only) ----
  // BUY: spend USD -> receive BASE (exact-in on USD)
  function quoteBuy(usdNotional: number) {
    const inputMintPk = new PublicKey(quoteMint);
    const amountInBN = toBN(usdNotional, quoteDecimals);

    const res: any = PoolUtils.getOutputAmountAndRemainAccounts(
      clmmInfo as any,
      tickArrayCache as any,
      inputMintPk,
      amountInBN
    );

    const expectedAmountOut: BN = res.expectedAmountOut;
    const remain = (res as any).remainAccounts ?? (res as any).remainingAccounts;
    const feeAmountBN: BN | undefined = res.feeAmount;

    const outA = bnToNumber(expectedAmountOut, baseDecs);
    const execPx = usdNotional / outA;

    // fee on input side (QUOTE)
    const buyFeeQuote =
      typeof feeAmountBN !== "undefined"
        ? bnToNumber(feeAmountBN, quoteDecimals)
        : new Decimal(usdNotional).mul(feePpm_one_leg).div(1_000_000).toNumber();

    const usedStarts = extractTickArrayStartsUsed(remain, tickArrayCache);
    const usedTag = usedStarts.length ? `used=[${usedStarts[0]}..${usedStarts[usedStarts.length - 1]}] (${usedStarts.length} arrays)` : "";

    return { outA, execPx, buyFeeQuote, usedTag };
  }

  // SELL: sell BASE -> receive exact USD (exact-out on USD)
  function quoteSell(usdNotional: number) {
    const outputMintPk = new PublicKey(quoteMint);
    const outBN = toBN(usdNotional, quoteDecimals);

    const res: any = PoolUtils.getInputAmountAndRemainAccounts(
      clmmInfo as any,
      tickArrayCache as any,
      outputMintPk,
      outBN
    );

    const expectedAmountIn: BN = res.expectedAmountIn;
    const remain = (res as any).remainAccounts ?? (res as any).remainingAccounts;
    const feeAmountBN: BN | undefined = res.feeAmount;

    const inA = bnToNumber(expectedAmountIn, baseDecs);
    const execPx = usdNotional / inA;

    // fee charged on input side (BASE)
    const sellFeeBase =
      typeof feeAmountBN !== "undefined"
        ? bnToNumber(feeAmountBN, baseDecs)
        : new Decimal(inA).mul(feePpm_one_leg).div(1_000_000).toNumber();

    const usedStarts = extractTickArrayStartsUsed(remain, tickArrayCache);
    const usedTag = usedStarts.length ? `used=[${usedStarts[0]}..${usedStarts[usedStarts.length - 1]}] (${usedStarts.length} arrays)` : "";

    return { inA, execPx, sellFeeBase, usedTag };
  }

  for (const usd of sizes) {
    try {
      const b = quoteBuy(usd);
      const s = quoteSell(usd);
      const rt_bps = ((b.execPx - s.execPx) / midUSDperBase) * 1e4;
      const impact_bps_total = Math.max(rt_bps - feeBps_total, 0);

      if (!argv.quiet) {
        const line = [
          `RT ${fmtUSD(usd).padStart(8)}  mid=${midUSDperBase.toFixed(8)}`,
          `buy=${b.execPx.toFixed(8)}  sell=${s.execPx.toFixed(8)}`,
          `rt=${rt_bps.toFixed(4)}bps  fee=${feeBps_total.toFixed(4)}bps  impact=${impact_bps_total.toFixed(4)}bps`,
        ].join("  ");
        console.log(line);
      }

      // CSV row (unified schema)
      csv?.write([
        new Date().toISOString(),
        "raydium",
        argv.pool,
        programId,
        tickSpacing,
        feePpm_one_leg,
        (feePpm_one_leg / 100).toFixed(4),
        protoFeePpm,
        (liquidity as BN).toString(),
        (sqrtPriceX64 as BN).toString(),
        tickCurrentIndex,
        mintA, decA, symbolA,
        mintB, decB, symbolB,
        baseMint, baseDecs, baseSymbol,
        quoteMint, quoteDecimals, quoteSymbol,
        usdPerQuote,
        midUSDperBase,
        usd,
        b.execPx,
        s.execPx,
        rt_bps,
        feeBps_total,
        impact_bps_total,
        b.outA,
        s.inA,
        b.buyFeeQuote,
        s.sellFeeBase,
      ]);
    } catch (e: any) {
      if (!argv.quiet) console.log(`RT  ${fmtUSD(usd)}: error ${e?.message || String(e)}`);
      csv?.write([
        new Date().toISOString(),
        "raydium",
        argv.pool,
        programId,
        tickSpacing,
        feePpm_one_leg,
        (feePpm_one_leg / 100).toFixed(4),
        protoFeePpm,
        (liquidity as BN).toString(),
        (sqrtPriceX64 as BN).toString(),
        tickCurrentIndex,
        mintA, decA, symbolA,
        mintB, decB, symbolB,
        baseMint, baseDecs, baseSymbol,
        quoteMint, quoteDecimals, quoteSymbol,
        1,                  // usd_per_quote (kept 1)
        Number.NaN,         // mid_usd_per_base
        usd,
        Number.NaN,         // buy_px_usd_per_base
        Number.NaN,         // sell_px_usd_per_base
        Number.NaN,         // roundtrip_bps
        feeBps_total,
        Number.NaN,         // impact_bps_total
        Number.NaN,         // buy_out_base
        Number.NaN,         // sell_in_base
        Number.NaN,         // buy_fee_quote
        Number.NaN,         // sell_fee_base
      ]);
    }
  }

  csv?.close?.();
})();
