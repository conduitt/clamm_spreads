import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import { Connection, PublicKey, Keypair, Transaction, VersionedTransaction } from "@solana/web3.js";
import BN from "bn.js";
import Decimal from "decimal.js";

import {
  WhirlpoolContext,
  buildWhirlpoolClient,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  swapQuoteByInputToken,
  swapQuoteByOutputToken,
} from "@orca-so/whirlpools-sdk";
import { DecimalUtil, Percentage } from "@orca-so/common-sdk";

import { mkCsvAppender } from "./csv.js";
import { Q64, USDC, toBps } from "./utils.js";

// ---------- CLI ----------
const argv = await yargs(hideBin(process.argv)).options({
  rpc: { type: "string", default: "https://api.mainnet-beta.solana.com" },
  pool: { type: "string", demandOption: true },
  sizes: { type: "string", default: "100,1000,5000,10000,100000,1000000" },
  range: { type: "string", desc: "A:B:S step in USD (overrides --sizes)" },
  sleepMs: { type: "number", default: 0, desc: "sleep between quotes" },
  quoteMint: { type: "string", desc: "Preferred QUOTE mint (e.g., USDC or SOL). If omitted, USDC if present; otherwise B side." },
  oraclePool: { type: "string", desc: "Pool to convert QUOTE↔USDC (must be QUOTE/USDC or USDC/QUOTE)" },
  csv: { type: "string" },
  quiet: { type: "boolean", default: false },
}).strict().parse();

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
const sizes = parseSizes(argv.sizes, argv.range);

// small helpers
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fmtUSD = (n: number) => `$${n.toLocaleString(undefined, { maximumFractionDigits: 6 })}`;

// ---------- symbols ----------
const MINT_SYMBOL: Record<string, string> = {
  So11111111111111111111111111111111111111112: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERZ8YK4QNoPgPOnTnKpXc9E8uCQbQax4y: "USDT",
};
const symbolForMint = (mint: string) => MINT_SYMBOL[mint] ?? "";

// ---------- Orca-compatible dummy wallet ----------
type OrcaWallet = {
  publicKey: PublicKey;
  payer: Keypair;
  signTransaction: <T extends Transaction | VersionedTransaction>(tx: T) => Promise<T>;
  signAllTransactions: <T extends Transaction | VersionedTransaction>(txs: T[]) => Promise<T[]>;
};

function mkDummyWallet(): OrcaWallet {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey,
    payer: kp,
    signTransaction: async <T extends Transaction | VersionedTransaction>(tx: T) => tx,
    signAllTransactions: async <T extends Transaction | VersionedTransaction>(txs: T[]) => txs,
  };
}

function csvHeader(): string[] {
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
    "sell_fee_base"
  ];
}

// Convert on-chain sqrtPriceX64 -> price (tokenB per tokenA), adjusted for decimals.
function calcPxBperA_fromSqrt(sqrtPriceX64: BN, decA: number, decB: number): Decimal {
  const sqrt = new Decimal(sqrtPriceX64.toString());
  const ratio = sqrt.div(new Decimal(Q64.toString())); // real sqrtP
  const pxBperA = ratio.mul(ratio).mul(new Decimal(10).pow(decA - decB));
  return pxBperA;
}

async function getMintDecimalsViaRPC(conn: Connection, mint: string): Promise<number> {
  if (mint === USDC) return 6;
  if (mint === "So11111111111111111111111111111111111111112") return 9;
  const info = await conn.getParsedAccountInfo(new PublicKey(mint));
  const dec = (info?.value as any)?.data?.parsed?.info?.decimals;
  return (typeof dec === "number") ? dec : 9;
}

// Given an oracle pool containing QUOTE and USDC, compute USD per QUOTE
async function usdPerQuoteFromOracle(
  conn: Connection,
  quoteMint: string,
  oraclePoolPk: PublicKey,
  ctx: ReturnType<typeof WhirlpoolContext["from"]>,
  client: ReturnType<typeof buildWhirlpoolClient>
): Promise<number | null> {
  try {
    const oracle = await client.getPool(oraclePoolPk);
    const d = oracle.getData();
    const mintA = d.tokenMintA.toBase58();
    const mintB = d.tokenMintB.toBase58();

    const decA = (await ctx.fetcher.getMintInfo(new PublicKey(mintA)))?.decimals ?? await getMintDecimalsViaRPC(conn, mintA);
    const decB = (await ctx.fetcher.getMintInfo(new PublicKey(mintB)))?.decimals ?? await getMintDecimalsViaRPC(conn, mintB);

    const pxBperA = calcPxBperA_fromSqrt(d.sqrtPrice, decA, decB); // B per A
    if (mintA === quoteMint && mintB === USDC) return pxBperA.toNumber();            // USD per QUOTE
    if (mintB === quoteMint && mintA === USDC) return new Decimal(1).div(pxBperA).toNumber();
    return null;
  } catch {
    return null;
  }
}

function pickQuoteMint(mintA: string, mintB: string, userQuote?: string): string {
  if (userQuote) return userQuote;
  if (mintA === USDC) return mintA;
  if (mintB === USDC) return mintB;
  return mintB; // default to B as quote (so base = A)
}

function asNumber(x: Decimal | number): number {
  return (x instanceof Decimal) ? x.toNumber() : x;
}

// ---------- Main ----------
(async () => {
  const connection = new Connection(argv.rpc, "confirmed");

  // Use a dummy wallet compatible with Orca's Wallet interface
  const wallet = mkDummyWallet();
  const ctx = WhirlpoolContext.from(connection, wallet, ORCA_WHIRLPOOL_PROGRAM_ID);
  const client = buildWhirlpoolClient(ctx);

  const poolPk = new PublicKey(argv.pool);
  const pool = await client.getPool(poolPk);
  const data = pool.getData();

  // token mints & decimals
  const mintA = data.tokenMintA.toBase58();
  const mintB = data.tokenMintB.toBase58();
  const mintInfoA = await ctx.fetcher.getMintInfo(new PublicKey(mintA));
  const mintInfoB = await ctx.fetcher.getMintInfo(new PublicKey(mintB));
  const decA = mintInfoA?.decimals ?? await getMintDecimalsViaRPC(connection, mintA);
  const decB = mintInfoB?.decimals ?? await getMintDecimalsViaRPC(connection, mintB);

  // symbols
  const symbolA = symbolForMint(mintA);
  const symbolB = symbolForMint(mintB);

  // Fee & pool params
  const tickSpacing = data.tickSpacing;
  const feePpm = Number(data.feeRate); // ppm (e.g., 400 -> 4 bps)
  const protoFeePpm = Number(data.protocolFeeRate);
  const feeBps_one_leg = feePpm / 100;
  const feeBps_roundtrip = feeBps_one_leg * 2;

  const liquidity = data.liquidity;
  const sqrtPriceX64 = data.sqrtPrice;
  const tickCurrent = data.tickCurrentIndex;

  // Decide QUOTE mint
  const quoteMint = pickQuoteMint(mintA, mintB, argv.quoteMint);
  const quoteDecimals = (quoteMint === mintA) ? decA : decB;
  const quoteSymbol = symbolForMint(quoteMint);

  // USD per QUOTE
  let usdPerQuote = 1;
  if (quoteMint === USDC) {
    usdPerQuote = 1;
  } else if (argv.oraclePool) {
    const oraclePk = new PublicKey(argv.oraclePool);
    const u = await usdPerQuoteFromOracle(connection, quoteMint, oraclePk, ctx, client);
    if (u && Number.isFinite(u) && u > 0) usdPerQuote = u;
  }

  // Derive BASE mint (non-quote)
  const quoteIsA = quoteMint === mintA;
  const baseMint = quoteIsA ? mintB : mintA;
  const baseDecs = quoteIsA ? decB : decA;
  const baseSymbol = symbolForMint(baseMint);

  // Pool-native price B per A, then QUOTE per BASE and USD per BASE
  const pxBperA = calcPxBperA_fromSqrt(sqrtPriceX64, decA, decB);
  let pxQuotePerBase: number;
  if (quoteIsA) {
    pxQuotePerBase = asNumber(new Decimal(1).div(pxBperA)); // A per B
  } else {
    pxQuotePerBase = asNumber(pxBperA);                      // B per A
  }
  const midUSDperBase = pxQuotePerBase * usdPerQuote;

  // Print pool summary
  if (!argv.quiet) {
    console.log("Pool Summary");
    console.log("------------");
    console.log(`Pool:                 ${poolPk.toBase58()}`);
    console.log(`Program:              ${ORCA_WHIRLPOOL_PROGRAM_ID.toBase58()}`);
    console.log(`tickSpacing:          ${tickSpacing}`);
    console.log(`feeRate (ppm):        ${feePpm}   (~${feeBps_one_leg.toFixed(4)} bps each leg)`);
    console.log(`protocolFeeRate(ppm): ${protoFeePpm}   (LP cut of fee)`);
    console.log(`liquidity (u128):     ${liquidity.toString()}`);
    console.log(`sqrtPrice_x64 (u128): ${sqrtPriceX64.toString()}`);
    console.log(`tickCurrentIndex:     ${tickCurrent}`);
    console.log(`tokenMintA:           ${mintA} (dec=${decA})`);
    console.log(`tokenMintB:           ${mintB} (dec=${decB})`);
    console.log(`quoteMint:            ${quoteMint} (dec=${quoteDecimals})`);
    console.log(`USD per QUOTE:        ${usdPerQuote}`);
    console.log(`BASE mint:            ${baseMint} (dec=${baseDecs})`);
    console.log(`Mid (USD per BASE):   ${midUSDperBase.toFixed(8)}\n`);
    console.log("Roundtrip results (USD-sized):");
    console.log("  Notional      Mid(USD/BASE)   BuyPx       SellPx      RT bps   Fee bps   Impact bps");
  }

  // CSV
  const csv = argv.csv ? mkCsvAppender(argv.csv) : null;
  if (csv) csv.write(csvHeader());

  const zeroSlip = Percentage.fromFraction(0, 1);

  for (const usd of sizes) {
    try {
      // BUY: spend QUOTE to receive BASE (Input: QUOTE exact-in)
      const quoteIn = usd / usdPerQuote;
      const buyInBN = DecimalUtil.toBN(new Decimal(quoteIn), quoteDecimals);
      const buy = await swapQuoteByInputToken(
        pool,
        new PublicKey(quoteMint),
        buyInBN,
        zeroSlip,
        ORCA_WHIRLPOOL_PROGRAM_ID,
        ctx.fetcher
      );

      const buyOutBase = DecimalUtil.fromBN(buy.estimatedAmountOut, baseDecs).toNumber();
      if (!(buyOutBase > 0)) throw new Error("BUY returned zero out amount");
      const buyFeeQuote = DecimalUtil.fromBN(buy.estimatedFeeAmount, quoteDecimals).toNumber();
      const buyExecPxUSDperBase = usd / buyOutBase;

      // SELL: deliver BASE to receive exact QUOTE (Output: QUOTE exact-out to get back 'usd')
      const needQuoteOut = usd / usdPerQuote;
      const sellOutBN = DecimalUtil.toBN(new Decimal(needQuoteOut), quoteDecimals);
      const sell = await swapQuoteByOutputToken(
        pool,
        new PublicKey(quoteMint),
        sellOutBN,
        zeroSlip,
        ORCA_WHIRLPOOL_PROGRAM_ID,
        ctx.fetcher
      );

      const sellInBase = DecimalUtil.fromBN(sell.estimatedAmountIn, baseDecs).toNumber();
      if (!(sellInBase > 0)) throw new Error("SELL returned zero in amount");
      const sellFeeBase = DecimalUtil.fromBN(sell.estimatedFeeAmount, baseDecs).toNumber();
      const sellExecPxUSDperBase = usd / sellInBase;

      // Roundtrip bps vs midUSDperBase
      const rt_bps = toBps((buyExecPxUSDperBase - sellExecPxUSDperBase) / midUSDperBase);
      const impact_bps = Math.max(rt_bps - feeBps_roundtrip, 0);

      if (!argv.quiet) {
        console.log(
          `RT ${fmtUSD(usd).padStart(8)}  mid=${midUSDperBase.toFixed(8)}  ` +
          `buy=${buyExecPxUSDperBase.toFixed(8)}  sell=${sellExecPxUSDperBase.toFixed(8)}  ` +
          `rt=${rt_bps.toFixed(4)}bps  fee=${feeBps_roundtrip.toFixed(4)}bps  impact=${impact_bps.toFixed(4)}bps`
        );
      }

      csv?.write([
        new Date().toISOString(),
        "orca",
        poolPk.toBase58(),
        ORCA_WHIRLPOOL_PROGRAM_ID.toBase58(),
        tickSpacing,
        feePpm,
        feeBps_one_leg.toFixed(4),
        protoFeePpm,
        liquidity.toString(),
        sqrtPriceX64.toString(),
        tickCurrent,
        mintA, decA, symbolA,
        mintB, decB, symbolB,
        baseMint, baseDecs, baseSymbol,
        quoteMint, quoteDecimals, quoteSymbol,
        usdPerQuote,
        midUSDperBase,
        usd,
        buyExecPxUSDperBase,
        sellExecPxUSDperBase,
        rt_bps,
        feeBps_roundtrip,
        impact_bps,
        buyOutBase,
        sellInBase,
        buyFeeQuote,
        sellFeeBase,
      ]);

      if (argv.sleepMs > 0) await sleep(argv.sleepMs);
    } catch (e: any) {
      if (!argv.quiet) console.log(`RT  ${fmtUSD(usd)}: error ${e?.message || String(e)}`);
      csv?.write([
        new Date().toISOString(),
        "orca",
        poolPk.toBase58(),
        ORCA_WHIRLPOOL_PROGRAM_ID.toBase58(),
        tickSpacing,
        feePpm,
        feeBps_one_leg.toFixed(4),
        protoFeePpm,
        liquidity.toString(),
        sqrtPriceX64.toString(),
        tickCurrent,
        mintA, decA, symbolA,
        mintB, decB, symbolB,
        baseMint, baseDecs, baseSymbol,
        quoteMint, quoteDecimals, quoteSymbol,
        usdPerQuote,
        Number.NaN, // mid_usd_per_base
        usd,
        Number.NaN, // buy_px_usd_per_base
        Number.NaN, // sell_px_usd_per_base
        Number.NaN, // roundtrip_bps
        feeBps_roundtrip,
        Number.NaN, // impact_bps_total
        Number.NaN, // buy_out_base
        Number.NaN, // sell_in_base
        Number.NaN, // buy_fee_quote
        Number.NaN, // sell_fee_base
      ]);
    }
  }

  csv?.close?.();
})();
