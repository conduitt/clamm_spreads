import { PublicKey } from "@solana/web3.js";

/** Well-known mints */
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
export const WSOL = "So11111111111111111111111111111111111111112";
export const WBTC = "9n4nbM75f5Ui33ZbPYXn59EwSgE8CGsHtAeTH5YFeJ9E";

/** Q64.64 constant used by both Orca and Raydium price math */
export const Q64 = 2n ** 64n;

/** Light symbol map (extend as you wish) */
const SYMBOL_MAP: Record<string, string> = {
  [USDC]: "USDC",
  [WSOL]: "SOL",
  [WBTC]: "WBTC",
};

/** Pretty print a mint as a short symbol or short base58 */
export function prettySymbol(mint: string | PublicKey): string {
  const k = typeof mint === "string" ? mint : mint.toBase58();
  return SYMBOL_MAP[k] ?? k.slice(0, 4);
}

/** Decimal helper without bringing a big library in here */
export function bnToNumber(bn: bigint, decimals: number): number {
  const base = 10n ** BigInt(decimals);
  const int = Number(bn / base);
  const frac = Number(bn % base) / Number(base);
  return int + frac;
}

/**
 * Given Orca's on-chain sqrtPrice (u128, Q64.64), and token decimals,
 * return price as "tokenB per tokenA" in FLOAT (be mindful for display only).
 */
export function midBPerA_fromSqrtX64(sqrtPriceX64: bigint, decA: number, decB: number): number {
  const ratio = Number(sqrtPriceX64) / Number(Q64); // sqrt(B/A) (scaled)
  const pxBperA = ratio * ratio * Math.pow(10, decA - decB);
  return pxBperA;
}

/**
 * If one side is USDC, derive USD per A.
 * - If B = USDC -> USD per A = B per A
 * - If A = USDC -> USD per A = 1 / (B per A)
 * Returns: { midUsdPerA, isUsdA, isUsdB }
 */
export function midUsdPerA_fromSqrt(
  sqrtPriceX64: bigint,
  mintA: string,
  decA: number,
  mintB: string,
  decB: number
): { midUsdPerA: number; isUsdA: boolean; isUsdB: boolean } {
  const isUsdA = mintA === USDC;
  const isUsdB = mintB === USDC;
  const pxBperA = midBPerA_fromSqrtX64(sqrtPriceX64, decA, decB);
  const midUsdPerA = isUsdB ? pxBperA : isUsdA ? 1 / pxBperA : pxBperA; // falls back to B/A if no USDC
  return { midUsdPerA, isUsdA, isUsdB };
}

/** bps utilities */
export const toBps = (x: number) => x * 1e4;
export const abs = (x: number) => (x < 0 ? -x : x);
