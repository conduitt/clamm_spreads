import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
  Connection,
  PublicKey,
  Keypair,
  Transaction,
  VersionedTransaction,
} from "@solana/web3.js";
import type { Wallet } from "@coral-xyz/anchor";
import BN from "bn.js";
import Decimal from "decimal.js";

import {
  WhirlpoolContext,
  buildWhirlpoolClient,
  ORCA_WHIRLPOOL_PROGRAM_ID,
  swapQuoteByInputToken,
  swapQuoteByOutputToken,
  PDAUtil,
} from "@orca-so/whirlpools-sdk";
import { DecimalUtil, Percentage } from "@orca-so/common-sdk";

import { mkCsvAppender } from "./csv.js";
import { Q64, USDC, toBps } from "./utils.js";

/* -------------------------------- Types ---------------------------------- */
type CsvAppender = {
  write: (row: Array<string | number>) => void;
  close?: () => void;
};
type SizeUnit = "usd" | "quote";
type PriceUnit = "usd" | "quote";

/* ------------------------------- CLI parse -------------------------------- */
const argv = await yargs(hideBin(process.argv))
  .options({
    usdMode: {
      type: "boolean",
      default: false,
      desc: "If set, default to USD sizing and USD prices (equivalent to --sizeUnit usd and --priceUnit usd), unless explicitly overridden. Also enables live SOL/USD pricing when SOL is the quote.",
    },
    rpc: { type: "string", default: "https://api.mainnet-beta.solana.com" },
    pool: { type: "string", demandOption: true, desc: "Target Whirlpool pubkey (e.g., SOL/BTC)" },
    sizes: { type: "string", default: "100,1000,5000,10000,100000,1000000" },
    range: { type: "string", desc: "A:B:S step (interpreted in --sizeUnit; overrides --sizes)" },
    sleepMs: { type: "number", default: 0, desc: "sleep between quotes (ms)" },

    sizeUnit: {
      type: "string",
      choices: ["usd", "quote"] as const,
      desc: "How to size trades: 'usd' or 'quote' (e.g., BTC). Default: 'usd' if USDC in pool, else 'quote'.",
    },
    priceUnit: {
      type: "string",
      choices: ["usd", "quote"] as const,
      desc: "How to report prices: 'usd' (USD per BASE) or 'quote' (QUOTE per BASE, e.g., BTC per SOL).",
    },

    quoteMint: {
      type: "string",
      desc:
        "Preferred QUOTE mint (e.g., USDC, BTC, SOL). If omitted, use USDC if present; else BTC if present; else token B.",
    },
    oraclePool: {
      type: "string",
      desc:
        "Required if --sizeUnit=usd and QUOTE≠USDC (or your usdMint). Whirlpool with USD vs QUOTE or USD vs BASE.",
    },
    usdMint: {
      type: "string",
      default: USDC as string,
      desc: "USD stable mint in the oracle pool. Defaults to USDC. Change if your oracle uses a different USD token.",
    },
    depthDump: {
      type: "number",
      desc: "Number of tick arrays (each 88×tickSpacing) to inspect on each side of the active tick. Prints liquidity distribution around active price."
    },
    csv: { type: "string" },
    quiet: { type: "boolean", default: false },
  })
  .strict()
  .parse();

/* ------------------------------- Utilities -------------------------------- */
function parseSizes(argvSizes: string, range?: string): number[] {
  if (range && range.includes(":")) {
    const [a, b, s] = range.split(":").map((x: string) => Number(x.trim()));
    if (Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(s) && s > 0) {
      const out: number[] = [];
      for (let v = a; v <= b; v += s) out.push(v);
      return out;
    }
  }
  return argvSizes
    .split(",")
    .map((s: string) => Number(s.trim()))
    .filter((n: number) => n > 0);
}
const sizes: number[] = parseSizes(argv.sizes as string, argv.range as string | undefined);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/* ------------------------------- Mint map --------------------------------- */
// Add both canonical soBTC and the pool’s BTC-like wrapper so labels come out right.
const BTC_MINTS = new Set<string>([
  "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E", // soBTC
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh", // your pool's BTC quote mint
]);

const MINT_SYMBOL: Record<string, string> = {
  So11111111111111111111111111111111111111112: "SOL",
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERZ8YK4QNoPgPOnTnKpXc9E8uCQbQax4y: "USDT",
  "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E": "BTC",
  "3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh": "BTC",
};
const symbolForMint = (mint: string): string => MINT_SYMBOL[mint] ?? "";

/* ------------------------------ Wallet shim ------------------------------- */
function mkDummyWallet(): Wallet {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey,
    payer: kp,
    async signTransaction<T extends Transaction | VersionedTransaction>(tx: T): Promise<T> { return tx; },
    async signAllTransactions<T extends Transaction | VersionedTransaction>(txs: T[]): Promise<T[]> { return txs; },
  };
}

/* ------------------------------- CSV header ------------------------------- */
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
    "size_unit","price_unit",
    "mid_quote_per_base",          // e.g., BTC per SOL
    "mid_usd_per_base",            // USD per SOL (if available/needed)
    "buy_px_quote_per_base",
    "sell_px_quote_per_base",
    "buy_px_usd_per_base",
    "sell_px_usd_per_base",
    "usd_per_quote",               // USD per BTC (if available/needed)
    "size_value",                  // raw size in the chosen size_unit
    "roundtrip_bps",
    "fee_bps_total",
    "impact_bps_total",
    "buy_out_base",
    "sell_in_base",
    "buy_fee_quote",
    "sell_fee_base",
  ];
}

/* --------------------------- Math & RPC helpers --------------------------- */
function calcPxBperA_fromSqrt(sqrtPriceX64: BN, decA: number, decB: number): Decimal {
  const sqrt = new Decimal(sqrtPriceX64.toString());
  const ratio = sqrt.div(new Decimal(String(Q64))); // Q64 is bigint
  return ratio.mul(ratio).mul(new Decimal(10).pow(decA - decB)); // B per A
}
async function getMintDecimalsViaRPC(conn: Connection, mint: string): Promise<number> {
  if (mint === (USDC as string)) return 6;
  if (mint === "So11111111111111111111111111111111111111112") return 9;
  const info = await conn.getParsedAccountInfo(new PublicKey(mint));
  const dec: unknown = (info?.value as any)?.data?.parsed?.info?.decimals;
  return typeof dec === "number" ? dec : 9;
}

/** Oracle: USD with QUOTE or USD with BASE; derive the other via cross. */
async function usdFromOracle(
  conn: Connection,
  oraclePoolPk: PublicKey,
  ctx: ReturnType<typeof WhirlpoolContext["from"]>,
  client: ReturnType<typeof buildWhirlpoolClient>,
  quoteMint: string,
  baseMint: string,
  pxQuotePerBase: number, // QUOTE per BASE from target pool
  usdMint: string
): Promise<{ usdPerQuote?: number; usdPerBase?: number } | null> {
  try {
    const oracle = await client.getPool(oraclePoolPk);
    const d = oracle.getData();
    const mintA = d.tokenMintA.toBase58();
    const mintB = d.tokenMintB.toBase58();

    const decA =
      (await ctx.fetcher.getMintInfo(new PublicKey(mintA)))?.decimals ??
      (await getMintDecimalsViaRPC(conn, mintA));
    const decB =
      (await ctx.fetcher.getMintInfo(new PublicKey(mintB)))?.decimals ??
      (await getMintDecimalsViaRPC(conn, mintB));

    const pxBperA = calcPxBperA_fromSqrt(d.sqrtPrice, decA, decB); // B per A

    // USD with QUOTE
    if (mintA === quoteMint && mintB === usdMint) return { usdPerQuote: pxBperA.toNumber() };
    if (mintB === quoteMint && mintA === usdMint) return { usdPerQuote: new Decimal(1).div(pxBperA).toNumber() };

    // USD with BASE
    if (mintA === baseMint && mintB === usdMint) {
      const usdPerBase = pxBperA.toNumber();
      return { usdPerBase, usdPerQuote: usdPerBase / pxQuotePerBase };
    }
    if (mintB === baseMint && mintA === usdMint) {
      const usdPerBase = new Decimal(1).div(pxBperA).toNumber();
      return { usdPerBase, usdPerQuote: usdPerBase / pxQuotePerBase };
    }

    return null;
  } catch {
    return null;
  }
}

/** Pick QUOTE: prefer user, else USDC if present, else BTC if present, else B */
function pickQuoteMint(mintA: string, mintB: string, userQuote?: string): string {
  if (userQuote) return userQuote;
  if (mintA === (USDC as string) || mintB === (USDC as string)) return mintA === (USDC as string) ? mintA : mintB;
  if (BTC_MINTS.has(mintA) || BTC_MINTS.has(mintB)) return BTC_MINTS.has(mintA) ? mintA : mintB;
  return mintB; // default to B
}
const asNumber = (x: Decimal | number): number => (x instanceof Decimal ? x.toNumber() : x);

/* --------------------------------- Main ----------------------------------- */
(async () => {
  const connection = new Connection((argv.rpc as string) ?? "", "confirmed");
  const wallet: Wallet = mkDummyWallet();
  const ctx = WhirlpoolContext.from(connection, wallet, ORCA_WHIRLPOOL_PROGRAM_ID);
  const client = buildWhirlpoolClient(ctx);

  // Target pool (e.g., SOL/BTC)
  const poolPk = new PublicKey(argv.pool as string);
  const pool = await client.getPool(poolPk);
  const data = pool.getData();

  // -------- Liquidity depth dump (if --depthDump N given) --------
  if (argv.depthDump && Number(argv.depthDump) > 0) {
    const nArrays = Number(argv.depthDump);
    const activeTick = data.tickCurrentIndex;
    console.log(`🔍 Liquidity depth (±${nArrays} arrays, tickSpacing=${data.tickSpacing}):`);
    const startArrayIndex = Math.floor(data.tickCurrentIndex / (data.tickSpacing * 88));
    const tickArrays: any[] = [];

    for (let i = -nArrays; i <= nArrays; i++) {
      const arrayStartTickIndex = (startArrayIndex + i) * data.tickSpacing * 88;
      const pda = PDAUtil.getTickArrayFromTickIndex(
        arrayStartTickIndex,
        data.tickSpacing,
        pool.getAddress(),
        ORCA_WHIRLPOOL_PROGRAM_ID
      );
      const ta = await ctx.fetcher.getTickArray(pda.publicKey);
      if (ta) tickArrays.push(ta);
    }
    let cumulative = new BN(0);
    for (const ta of tickArrays) {
      if (!ta || !ta.data || !ta.data.ticks) continue;
      for (const tick of ta.data.ticks) {
        if (!tick) continue;
        const liqNet = new BN(tick.liquidityNet);
        if (!liqNet.isZero()) {
          cumulative = cumulative.add(liqNet);
          console.log(`tick=${tick.tickIndex.toString().padStart(8)}  liqNet=${liqNet.toString().padStart(20)}  cum=${cumulative.toString()}`);
        }
      }
    }
    console.log(`(Displayed liquidity range around tick ${activeTick})\n`);
  }

  // Mints & decimals
  const mintA = data.tokenMintA.toBase58();
  const mintB = data.tokenMintB.toBase58();
  const decA = (await ctx.fetcher.getMintInfo(new PublicKey(mintA)))?.decimals
    ?? (await getMintDecimalsViaRPC(connection, mintA));
  const decB = (await ctx.fetcher.getMintInfo(new PublicKey(mintB)))?.decimals
    ?? (await getMintDecimalsViaRPC(connection, mintB));

  // Symbols
  const symbolA = symbolForMint(mintA);
  const symbolB = symbolForMint(mintB);

  // Fees & pool params
  const tickSpacing = data.tickSpacing;
  const feePpm = Number(data.feeRate);
  const protoFeePpm = Number(data.protocolFeeRate);
  const feeBps_one_leg = feePpm / 100;
  const feeBps_roundtrip = feeBps_one_leg * 2;

  const liquidity = data.liquidity;
  const sqrtPriceX64 = data.sqrtPrice;
  const tickCurrent = data.tickCurrentIndex;

  // QUOTE & BASE
  const quoteMint = pickQuoteMint(mintA, mintB, argv.quoteMint as string | undefined);
  // Auto-detect SOL as quote token for SOL pairs
  if (!argv.quoteMint) {
    const SOL_MINT = "So11111111111111111111111111111111111111112";
    if (mintA === SOL_MINT || mintB === SOL_MINT) {
      console.log("🔧 Auto-detected SOL as quote token (Orca)");
      argv.quoteMint = SOL_MINT;
    }
  }
  const quoteIsA = quoteMint === mintA;
  const baseMint = quoteIsA ? mintB : mintA;
  const baseDecs = quoteIsA ? decB : decA;
  const quoteDecimals = quoteIsA ? decA : decB;
  const quoteSymbol = symbolForMint(quoteMint) || "QUOTE";
  const baseSymbol = symbolForMint(baseMint) || "BASE";

  // Mid QUOTE per BASE from target pool
  const pxBperA = calcPxBperA_fromSqrt(sqrtPriceX64 as BN, decA, decB);
  const pxQuotePerBase = quoteIsA ? asNumber(new Decimal(1).div(pxBperA)) : asNumber(pxBperA);

  // Decide units (defaults: size=usd if USDC in pool; else quote. price=quote if no USD, else usd)
  const defaultSizeUnit: SizeUnit = (mintA === (USDC as string) || mintB === (USDC as string)) ? "usd" : "quote";
  const defaultPriceUnit: PriceUnit = (mintA === (USDC as string) || mintB === (USDC as string)) ? "usd" : "quote";
  let sizeUnit: SizeUnit = ((argv.sizeUnit as SizeUnit | undefined) ?? defaultSizeUnit);
  let priceUnit: PriceUnit = ((argv.priceUnit as PriceUnit | undefined) ?? defaultPriceUnit);

  // If --usdMode is set, prefer USD sizing/pricing unless user explicitly set units
  if (argv.usdMode) {
    if (argv.sizeUnit === undefined) sizeUnit = "usd";
    if (argv.priceUnit === undefined) priceUnit = "usd";
  }

  // USD conversions (needed if sizeUnit=usd or priceUnit=usd)
  const usdMint = ((argv.usdMint as string) || (USDC as string));
  let usdPerQuote = Number.NaN;     // USD per QUOTE (e.g., USD/BTC)
  let usdPerBase  = Number.NaN;     // USD per BASE  (e.g., USD/SOL)
  let haveUSD = false;
  let solUsdPrice: number | undefined = undefined;
  let solUsdDecimals: number | undefined = undefined;
  let usingSolUsdLive = false;

  const needUSD = (sizeUnit === "usd") || (priceUnit === "usd");
  // Detect if quoteMint is SOL
  const SOL_MINT = "So11111111111111111111111111111111111111112";
  if (needUSD && argv.usdMode && quoteMint === SOL_MINT) {
    // Use Orca SOL/USDC pool for live SOL/USD price
    const solUsdPoolPk = new PublicKey("Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE");
    const solUsdPool = await client.getPool(solUsdPoolPk);
    const solUsdData = solUsdPool.getData();
    const solMintA = solUsdData.tokenMintA.toBase58();
    const solMintB = solUsdData.tokenMintB.toBase58();
    const solDecA =
      (await ctx.fetcher.getMintInfo(new PublicKey(solMintA)))?.decimals ??
      (await getMintDecimalsViaRPC(connection, solMintA));
    const solDecB =
      (await ctx.fetcher.getMintInfo(new PublicKey(solMintB)))?.decimals ??
      (await getMintDecimalsViaRPC(connection, solMintB));
    // Determine which side is SOL, which is USDC
    // Want SOL/USD (USD = USDC)
    let sqrt = new Decimal(solUsdData.sqrtPrice.toString());
    let pxBperA = sqrt.div(new Decimal(String(Q64))).pow(2).mul(new Decimal(10).pow(solDecA - solDecB));
    // If tokenMintA is SOL, B is USDC, pxBperA = USDC per SOL
    // If tokenMintB is SOL, pxAperB = USDC per SOL, so invert
    let solUsd: Decimal;
    if (solMintA === SOL_MINT && solMintB === USDC) {
      solUsd = pxBperA;
    } else if (solMintB === SOL_MINT && solMintA === USDC) {
      solUsd = new Decimal(1).div(pxBperA);
    } else {
      throw new Error("Could not find SOL/USDC in pool Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE");
    }
    solUsdPrice = solUsd.toNumber();
    solUsdDecimals = solDecB; // USDC decimals
    usdPerQuote = solUsdPrice;
    usdPerBase = pxQuotePerBase * usdPerQuote;
    haveUSD = true;
    usingSolUsdLive = true;
    console.log(`💰 Using live SOL/USD rate ${solUsdPrice.toFixed(8)} from pool Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE`);
  } else if (needUSD) {
    if (quoteMint === usdMint || quoteMint === (USDC as string)) {
      usdPerQuote = 1;
      usdPerBase  = pxQuotePerBase * usdPerQuote;
      haveUSD = true;
    } else {
      const oraclePoolStr = argv.oraclePool as string | undefined;
      if (!oraclePoolStr) {
        const need = symbolForMint(quoteMint) || quoteMint;
        throw new Error(
          `USD conversion needed (sizeUnit=${sizeUnit}, priceUnit=${priceUnit}) but QUOTE is not USD (${need}). ` +
          `Provide --oraclePool=<Whirlpool pubkey> with usdMint (${usdMint}) vs QUOTE or usdMint vs BASE.`
        );
      }
      const orc = await usdFromOracle(
        connection,
        new PublicKey(oraclePoolStr),
        ctx,
        client,
        quoteMint,
        baseMint,
        pxQuotePerBase,
        usdMint
      );
      if (!orc || (!orc.usdPerQuote && !orc.usdPerBase)) {
        throw new Error(
          `Oracle pool must include usdMint (${usdMint}) with QUOTE or BASE. Given: ${oraclePoolStr}`
        );
      }
      if (orc.usdPerQuote) {
        usdPerQuote = orc.usdPerQuote;
        usdPerBase  = pxQuotePerBase * usdPerQuote;
      } else {
        usdPerBase  = orc.usdPerBase!;
        usdPerQuote = usdPerBase / pxQuotePerBase;
      }
      haveUSD = true;
    }
  }

  // Header
  if (!argv.quiet) {
    console.log("Pool Summary");
    console.log("------------");
    console.log(`Pool:                 ${poolPk.toBase58()}  (${symbolA}/${symbolB})`);
    console.log(`Program:              ${ORCA_WHIRLPOOL_PROGRAM_ID.toBase58()}`);
    console.log(`tickSpacing:          ${tickSpacing}`);
    console.log(`feeRate (ppm):        ${feePpm}   (~${feeBps_one_leg.toFixed(4)} bps each leg)`);
    console.log(`protocolFeeRate(ppm): ${protoFeePpm}   (LP cut of fee)`);
    console.log(`liquidity (u128):     ${liquidity.toString()}`);
    console.log(`sqrtPrice_x64 (u128): ${sqrtPriceX64.toString()}`);
    console.log(`tickCurrentIndex:     ${tickCurrent}`);
    console.log(`quoteMint:            ${quoteMint} (${quoteSymbol}) dec=${quoteDecimals}`);
    console.log(`baseMint:             ${baseMint} (${baseSymbol}) dec=${baseDecs}`);
    console.log(`Size Unit:            ${sizeUnit}`);
    console.log(`Price Unit:           ${priceUnit}`);
    console.log(`Mid QUOTE/BASE:       ${pxQuotePerBase.toFixed(12)} ${quoteSymbol}/${baseSymbol}`);
    if (haveUSD) {
      console.log(`USD mint (oracle):    ${usdMint}`);
      console.log(`Mid (USD per BASE):   ${usdPerBase.toFixed(8)}\n`);
    } else {
      console.log("");
    }

    if (priceUnit === "usd") {
      console.log("Roundtrip results (prices in USD/BASE):");
      console.log("  Size     Unit   Mid(USD/BASE)   BuyPx       SellPx      RT bps   Fee bps   Impact bps");
    } else {
      console.log(`Roundtrip results (prices in ${quoteSymbol}/${baseSymbol}):`);
      console.log(`  Size     Unit   Mid(${quoteSymbol}/${baseSymbol})   BuyPx       SellPx      RT bps   Fee bps   Impact bps`);
    }
  }

  // CSV
  const csv: CsvAppender | null = argv.csv
    ? (mkCsvAppender(argv.csv as string) as unknown as CsvAppender)
    : null;
  if (csv) csv.write(csvHeader());

  const zeroSlip = Percentage.fromFraction(0, 1);

  for (const size of sizes) {
    try {
      // USD mode flag and mid price
      const usdMode = argv.usdMode as boolean | undefined;
      const midQuotePerBase = pxQuotePerBase;
      // Compute quote amounts based on sizeUnit or usdMode
      let quoteIn: number;
      let needQuoteOut: number;

      if (usdMode && quoteMint === SOL_MINT && usingSolUsdLive && solUsdPrice && solUsdPrice > 0) {
        // Convert USD notionals to SOL using live SOL/USD rate
        // Each USD notional becomes size / solUsdPrice SOL
        quoteIn = size / solUsdPrice;
        needQuoteOut = size / solUsdPrice;
        if (!argv.quiet) {
          console.log(`⚙️ USD mode active — using live SOL/USD rate`);
        }
      } else if (usdMode) {
        if (!haveUSD) throw new Error("USD conversion not available (missing oracle).");
        // Convert USD notionals to quote units using current mid price
        quoteIn = (size / usdPerQuote) / midQuotePerBase;
        needQuoteOut = (size / usdPerQuote) / midQuotePerBase;
        if (!argv.quiet) {
          console.log(`💵 USD mode active — converted ${size} USD notionals using mid=${midQuotePerBase.toFixed(4)} ${quoteSymbol}/${baseSymbol}`);
        }
      } else if (sizeUnit === "usd") {
        if (!haveUSD) throw new Error("USD conversion not available (missing oracle).");
        quoteIn = size / usdPerQuote;      // BUY exact-in quote
        needQuoteOut = size / usdPerQuote; // SELL exact-out quote
      } else {
        quoteIn = size;
        needQuoteOut = size;
      }

      // BUY: spend QUOTE to receive BASE (Input: QUOTE exact-in)
      const buyInBN = DecimalUtil.toBN(new Decimal(quoteIn), quoteDecimals);
      const buy = await swapQuoteByInputToken(
        pool, new PublicKey(quoteMint), buyInBN, zeroSlip, ORCA_WHIRLPOOL_PROGRAM_ID, ctx.fetcher
      );
      const buyOutBase = DecimalUtil.fromBN(buy.estimatedAmountOut, baseDecs).toNumber();
      if (!(buyOutBase > 0)) throw new Error("BUY returned zero out amount");
      const buyFeeQuote = DecimalUtil.fromBN(buy.estimatedFeeAmount, quoteDecimals).toNumber();

      // SELL: deliver BASE to receive exact QUOTE (Output: QUOTE exact-out)
      const sellOutBN = DecimalUtil.toBN(new Decimal(needQuoteOut), quoteDecimals);
      const sell = await swapQuoteByOutputToken(
        pool, new PublicKey(quoteMint), sellOutBN, zeroSlip, ORCA_WHIRLPOOL_PROGRAM_ID, ctx.fetcher
      );
      const sellInBase = DecimalUtil.fromBN(sell.estimatedAmountIn, baseDecs).toNumber();
      if (!(sellInBase > 0)) throw new Error("SELL returned zero in amount");
      const sellFeeBase = DecimalUtil.fromBN(sell.estimatedFeeAmount, baseDecs).toNumber();

      // Prices in requested priceUnit
      const mid_quote = pxQuotePerBase;                        // QUOTE per BASE
      const buy_quote = quoteIn / buyOutBase;
      const sell_quote = needQuoteOut / sellInBase;

      const mid_usd = haveUSD ? usdPerBase : Number.NaN;       // USD per BASE
      const buy_usd = haveUSD ? ( (sizeUnit === "usd" ? size : quoteIn * usdPerQuote) / buyOutBase ) : Number.NaN;
      const sell_usd = haveUSD ? ( (sizeUnit === "usd" ? size : needQuoteOut * usdPerQuote) / sellInBase ) : Number.NaN;

      const mid   = (priceUnit === "quote") ? mid_quote : mid_usd;
      const buyPx = (priceUnit === "quote") ? buy_quote : buy_usd;
      const sellPx= (priceUnit === "quote") ? sell_quote : sell_usd;

      const rt_bps = toBps((buyPx - sellPx) / mid) as number;
      const impact_bps = Math.max(rt_bps - feeBps_roundtrip, 0);

      if (!argv.quiet) {
        const fmt = (x: number, d: number) => x.toFixed(d);
        const sizeStr = size.toLocaleString(undefined, { maximumFractionDigits: 6 }).padStart(8);
        if (priceUnit === "usd") {
          console.log(
            `RT ${sizeStr}  ${sizeUnit.padEnd(5)}  mid=${fmt(mid_usd,8)}  buy=${fmt(buy_usd,8)}  sell=${fmt(sell_usd,8)}  ` +
            `rt=${rt_bps.toFixed(4)}bps  fee=${feeBps_roundtrip.toFixed(4)}bps  impact=${impact_bps.toFixed(4)}bps`
          );
        } else {
          console.log(
            `RT ${sizeStr}  ${sizeUnit.padEnd(5)}  mid=${fmt(mid_quote,12)}  buy=${fmt(buy_quote,12)}  sell=${fmt(sell_quote,12)}  ` +
            `rt=${rt_bps.toFixed(4)}bps  fee=${feeBps_roundtrip.toFixed(4)}bps  impact=${impact_bps.toFixed(4)}bps`
          );
        }
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
        sizeUnit, priceUnit,
        mid_quote,
        mid_usd,
        buy_quote,
        sell_quote,
        buy_usd,
        sell_usd,
        usdPerQuote,
        size,
        rt_bps,
        feeBps_roundtrip,
        impact_bps,
        buyOutBase,
        sellInBase,
        buyFeeQuote,
        sellFeeBase,
      ]);

      if ((argv.sleepMs as number) > 0) await sleep(argv.sleepMs as number);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!argv.quiet) console.log(`RT (size=${size} ${sizeUnit}) error: ${msg}`);
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
        quoteMint, quoteDecimals, symbolForMint(quoteMint) || "QUOTE",
        sizeUnit, priceUnit,
        Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN, Number.NaN,
        Number.NaN, size,
        Number.NaN, feeBps_roundtrip, Number.NaN,
        Number.NaN, Number.NaN, Number.NaN, Number.NaN,
      ]);
    }
  }

  csv?.close?.();
})();
