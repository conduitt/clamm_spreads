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
const fmtNum = (n: number, d = 8) => n.toLocaleString(undefined, { maximumFractionDigits: d });
const fmtBig = (s: unknown) =>
  (typeof s === "string" ? s : (s as any)?.toString?.() ?? String(s)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");

const toBN = (amt: number, dec: number) => new BN(new Decimal(amt).mul(Decimal.pow(10, dec)).toFixed(0));
const bnToNumber = (bn: BN, dec: number) => new Decimal(bn.toString()).div(Decimal.pow(10, dec)).toNumber();

async function getMintDecimalsViaRPC(conn: Connection, mint: string): Promise<number> {
  if (mint === WSOL) return 9;
  if (mint === USDC) return 6;
  const info = await conn.getParsedAccountInfo(new PublicKey(mint));
  const dec = (info?.value as any)?.data?.parsed?.info?.decimals;
  if (typeof dec === "number") return dec;
  if (!argv.quiet) console.warn(`Warn: unable to fetch decimals for ${mint}, defaulting to 9`);
  return 9;
}

// Convert on-chain sqrtPriceX64 -> price (tokenB per tokenA), adjusted for decimals.
// Return USD per A (if USDC is A: invert B/A)
function midUsdPerA_fromSqrt(
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
  if (isUsdB) return pxBperA.toNumber(); // USD is B: USD per A
  if (isUsdA) return new Decimal(1).div(pxBperA).toNumber(); // USD is A: invert
  return pxBperA.toNumber(); // neither is USD (we still return B/A)
}

function normalizeFeePpm(raw: unknown): number {
  const n = Number(raw ?? 0);
  if (!Number.isFinite(n) || n === 0) return 0;
  if (n > 0 && n < 1) return Math.round(n * 1_000_000); // fraction -> ppm
  return Math.round(n); // already ppm
}

// normalize the tick-array cache into { [start]: { startTickIndex, ticks } } ---
function normalizeTickArrayCache(raw: Record<string, any>): Record<string, { startTickIndex: number; ticks: any[]; address?: any }> {
  const out: Record<string, { startTickIndex: number; ticks: any[]; address?: any }> = {};
  for (const [k, v] of Object.entries(raw ?? {})) {
    const start =
      (v as any)?.startTickIndex ??
      (v as any)?.data?.startTickIndex ??
      Number.isFinite(Number(k)) ? Number(k) : undefined;

    const ticks = (v as any)?.ticks ?? (v as any)?.data?.ticks ?? [];
    if (typeof start === "number" && Array.isArray(ticks)) {
      out[String(start)] = {
        startTickIndex: start,
        ticks,
        address: (v as any)?.address ?? (v as any)?.id ?? (v as any)?.pubkey,
      };
    }
  }
  return out;
}

// CSV header (Orca-aligned)
function csvHeader(): (string | number)[] {
  return [
    "ts_utc",
    "pool",
    "program_id",
    "tick_spacing",
    "fee_ppm",
    "fee_bps",
    "protocol_fee_ppm",
    "liquidity_u128",
    "sqrt_price_x64",
    "tick_current",
    "mintA", "decA", "mintB", "decB",
    "mid_usd_per_A",
    "usd_notional",
    "buy_exec_px",
    "sell_exec_px",
    "roundtrip_bps",
    "fee_bps_total",
    "impact_bps_total",
    "buy_qty_out_A",
    "sell_qty_in_A",
    "buy_fee_usd",
    "sell_fee_usd",
    "sell_fee_A",
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
  }

  const conn = new Connection(argv.rpc, "confirmed");

  const raydium = await Raydium.load({
    connection: conn as any,
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

  // Tick arrays cache for this pool (normalize it so estimator can read startTickIndex)
  const taCacheMap = await PoolUtils.fetchMultiplePoolTickArrays({
    connection: conn as any,
    poolKeys: [clmmInfo],
  });

  const rawCache: Record<string, any> = (taCacheMap as any)[argv.pool] || {};
  const tickArrayCache = normalizeTickArrayCache(rawCache);

  if (!argv.quiet) {
    const nArrays = Object.keys(tickArrayCache).length;
    console.log(`Loaded ${nArrays} tick arrays into cache`);
  }

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

  const midUSDperA = midUsdPerA_fromSqrt(sqrtPriceX64, decA, decB, mintA, mintB);
  const isUsdA = mintA === USDC;
  const isUsdB = mintB === USDC;

  if (!argv.quiet) {
    console.log("\nRaydium CLMM Pool Summary");
    console.log("-------------------------");
    console.log(`Pool:                 ${argv.pool}`);
    console.log(`Program:              ${programId}`);
    console.log(`tickSpacing:          ${tickSpacing}`);
    console.log(`feeRate (ppm):        ${feePpm_one_leg}   (~${(feePpm_one_leg / 100).toFixed(4)} bps each leg)`);
    console.log(`protocolFeeRate(ppm): ${protoFeePpm}`);
    console.log(`liquidity (u128?):    ${fmtBig(liquidity.toString())}`);
    console.log(`sqrtPrice_x64:        ${fmtBig(sqrtPriceX64.toString())}`);
    console.log(`tickCurrent:          ${tickCurrentIndex}`);
    console.log(`tokenMintA:           ${mintA} (dec=${decA})`);
    console.log(`tokenMintB:           ${mintB} (dec=${decB})`);
    console.log(`Mid (USD per A):      ${midUSDperA.toFixed(8)}\n`);
    console.log("Roundtrip results (USD-sized):");
    console.log("  Notional      Mid(USD/BASE)   BuyPx       SellPx      RT bps   Fee bps   Impact bps");
  }

  // CSV
  const csv = argv.csv ? mkCsvAppender(argv.csv, csvHeader()) : null;

  // ---- Quote helpers (pool-only) ----
  // BUY: spend USD -> receive A (exact-in on USD)
  function quoteBuy(usdNotional: number) {
    const usdMint = isUsdB ? mintB : isUsdA ? mintA : mintB;
    const usdDec = usdMint === mintA ? decA : decB;
    const inputMintPk = new PublicKey(usdMint);
    const amountInBN = toBN(usdNotional, usdDec);

    const res: any = PoolUtils.getOutputAmountAndRemainAccounts(
      clmmInfo as any,
      tickArrayCache as any,
      inputMintPk,
      amountInBN
    );

    const expectedAmountOut: BN = res.expectedAmountOut;
    const remain = (res as any).remainAccounts ?? (res as any).remainingAccounts;
    const feeAmountBN: BN | undefined = res.feeAmount;

    const outDec = usdMint === mintA ? decB : decA; // non-USD side
    const outA = bnToNumber(expectedAmountOut, outDec);
    const inUSD = usdNotional;
    const execPx = inUSD / outA;

    const totalBps = Math.abs((execPx / midUSDperA - 1) * 1e4);
    const impactBps = Math.max(totalBps - feeBps_one_leg, 0);

    // fee on input side (USD)
    const buyFeeUSD =
      typeof feeAmountBN !== "undefined"
        ? bnToNumber(feeAmountBN, usdDec)
        : new Decimal(inUSD).mul(feePpm_one_leg).div(1_000_000).toNumber();

    // We keep the ‘used tick arrays’ note optional (not printed to CSV)
    void remain;
    return { outA, inUSD, execPx, totalBps, impactBps, buyFeeUSD };
  }

  // SELL: sell A -> receive exact USD (exact-out on USD)
  function quoteSell(usdNotional: number) {
    const usdMint = isUsdB ? mintB : isUsdA ? mintA : mintB;
    const usdDec = usdMint === mintA ? decA : decB;
    const outputMintPk = new PublicKey(usdMint);
    const outBN = toBN(usdNotional, usdDec);

    const res: any = PoolUtils.getInputAmountAndRemainAccounts(
      clmmInfo as any,
      tickArrayCache as any,
      outputMintPk,
      outBN
    );

    const expectedAmountIn: BN = res.expectedAmountIn;
    const remain = (res as any).remainAccounts ?? (res as any).remainingAccounts;
    const feeAmountBN: BN | undefined = res.feeAmount;

    const inADec = usdMint === mintB ? decA : decB; // non-USD side
    const inA = bnToNumber(expectedAmountIn, inADec);
    const outUSD = usdNotional;
    const execPx = outUSD / inA;

    // fee charged on input side (A)
    const feeA =
      typeof feeAmountBN !== "undefined"
        ? bnToNumber(feeAmountBN, inADec)
        : new Decimal(inA).mul(feePpm_one_leg).div(1_000_000).toNumber();
    const sellFeeUSD = feeA * execPx;

    const totalBps = Math.abs((execPx / midUSDperA - 1) * 1e4);
    const impactBps = Math.max(totalBps - feeBps_one_leg, 0);

    void remain;
    return { inA, outUSD, execPx, totalBps, impactBps, feeA, sellFeeUSD };
  }

  for (const usd of sizes) {
    try {
      const b = quoteBuy(usd);
      const s = quoteSell(usd);
      const rt_bps = ((b.execPx - s.execPx) / midUSDperA) * 1e4;
      const impact_bps_total = Math.max(rt_bps - feeBps_total, 0);

      if (!argv.quiet) {
        console.log(
          `RT ${fmtUSD(usd).padStart(8)}  mid=${midUSDperA.toFixed(8)}  ` +
          `buy=${b.execPx.toFixed(8)}  sell=${s.execPx.toFixed(8)}  ` +
          `rt=${rt_bps.toFixed(4)}bps  fee=${(feeBps_total).toFixed(4)}bps  impact=${impact_bps_total.toFixed(4)}bps`
        );
      }

      // CSV row (aligned schema)
      csv?.write([
        new Date().toISOString(),
        argv.pool,
        programId,
        tickSpacing,
        feePpm_one_leg,
        (feePpm_one_leg / 100).toFixed(4),
        protoFeePpm,
        (liquidity as BN).toString(),
        (sqrtPriceX64 as BN).toString(),
        tickCurrentIndex,
        mintA, decA, mintB, decB,
        midUSDperA,
        usd,
        b.execPx,
        s.execPx,
        rt_bps,
        feeBps_total,
        impact_bps_total,
        b.outA,
        s.inA,
        b.buyFeeUSD,
        s.sellFeeUSD,
        s.feeA,
      ]);
    } catch (e: any) {
      const msg = e?.message || String(e);
      if (!argv.quiet) console.log(`RT  ${fmtUSD(usd)}: error ${msg}`);
      csv?.write([
        new Date().toISOString(),
        argv.pool,
        programId,
        tickSpacing,
        feePpm_one_leg,
        (feePpm_one_leg / 100).toFixed(4),
        protoFeePpm,
        (liquidity as BN).toString(),
        (sqrtPriceX64 as BN).toString(),
        tickCurrentIndex,
        mintA, decA, mintB, decB,
        midUSDperA,
        usd,
        Number.NaN, // buy_exec_px
        Number.NaN, // sell_exec_px
        Number.NaN, // roundtrip_bps
        feeBps_total,
        Number.NaN, // impact_bps_total
        Number.NaN, // buy_qty_out_A
        Number.NaN, // sell_qty_in_A
        Number.NaN, // buy_fee_usd
        Number.NaN, // sell_fee_usd
        Number.NaN, // sell_fee_A
      ]);
    }
  }

  csv?.close?.();
})().catch((e) => {
  console.error("Fatal:", e);
  process.exit(1);
});
