
# CLMM Spreads — Orca & Raydium probes (USD pools)

Lightweight, RPC‑only spread/impact probes for **single pools** on Solana:

- **Orca Whirlpools** (Orca CLMM)
- **Raydium CLMM** (`@raydium-io/raydium-sdk-v2`)

They fetch on‑chain pool state + tick arrays, compute **BUY** (USD→BASE exact‑in) and **SELL** (BASE→USD exact‑out) quotes on **that pool only**, then print a summary and write a CSV.

Quotes use **zero slippage tolerance** in the SDK calls. This measures pool‑native execution at size (fee + curve depth) without adding user‑side buffers.

> **Scope / assumption**
> These probes are intended for **USD pools** (USDC on one side). If the pool doesn’t include USDC, the scripts still run and prices are reported as **QUOTE per BASE** (not true USD). Extending to non‑USD pools requires adding an oracle to convert the quote asset to USD.

---

## Quick start

```bash
# 1) install deps
npm i

# 2) build
npm run build
```

---

## Usage

### Raydium CLMM

Example: USDC/SOL pool — print and write CSV over a size range

```bash
node dist/raydium_probe.js \
  --pool 3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv \
  --range 5000:50000:5000 \
  --csv rt_raydium_usdc_sol.csv
```

### Orca Whirlpools

Example: print and write CSV over a size range

```bash
node dist/orca_probe.js \
  --pool Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE \
  --range 5000:50000:5000 \
  --csv rt_orca_usdc_sol.csv
```

---

## Flags (shared)

| Flag | Type | Default | Notes |
|---|---|---:|---|
| `--pool` | `string` | *required* | Pool public key (Orca Whirlpool or Raydium CLMM). |
| `--rpc` | `string` | `https://api.mainnet-beta.solana.com` | Use your own RPC for speed / rate limits. |
| `--sizes` | `comma-list` | `100,1000,5000,10000,100000,1000000` | USD notionals (e.g. `--sizes 100,250,1000`). |
| `--range` | `start:end:step` | *none* | Alternative to `--sizes`. Example: `--range 5000:50000:5000`. If both are passed, **range wins**. |
| `--csv` | `string` | *none* | If set, appends rows to this CSV file (schema below). |
| `--quiet` | `bool` | `false` | Suppress console table; only write CSV rows. |

> **Size semantics:** sizes are interpreted as **USD notionals** when the quote side is **USDC**. If quote ≠ USDC, they represent **quote‑token** notionals, but the column names remain unchanged for compatibility.

---

## CSV schema (current output)

The probes currently write a **unified (verbose) schema** per row. Header (exact order):

```
wts_utc,dex,pool,program_id,tick_spacing,fee_ppm,fee_bps,protocol_fee_ppm,liquidity_u128,sqrt_price_x64,tick_current,mintA,decA,symbolA,mintB,decB,symbolB,base_mint,base_decimals,base_symbol,quote_mint,quote_decimals,quote_symbol,usd_per_quote,mid_usd_per_base,usd_notional,buy_px_usd_per_base,sell_px_usd_per_base,roundtrip_bps,fee_bps_total,impact_bps_total,buy_out_base,sell_in_base,buy_fee_quote,sell_fee_base
```

### Column semantics

**Key columns (what you’ll usually keep):**
- `wts_utc` — ISO timestamp (UTC) when the quotes were taken.
- `dex` — `"orca"` or `"raydium"`.
- `pool` — Pool pubkey.
- `usd_notional` — Size of the roundtrip in USD (if quote=USDC; otherwise quote‑token notional).
- `mid_usd_per_base` — Mid from on‑chain `sqrt_price_x64` (USD per BASE when quote=USDC; otherwise quote per BASE).
- `buy_px_usd_per_base` — Executed BUY price (USD/BASE) for **USD→BASE** exact‑in.
- `sell_px_usd_per_base` — Executed SELL price (USD/BASE) for **BASE→USD** exact‑out.
- `roundtrip_bps` — `(buy_px_usd_per_base − sell_px_usd_per_base) / mid_usd_per_base * 1e4`.
- `fee_bps_total` — **Roundtrip** fee in bps (`2 × per‑leg taker fee`). Protocol fee cut is reported separately.
- `impact_bps_total` — AMM curve/tick‑depth component: `max(roundtrip_bps − fee_bps_total, 0)`.

**Extras:**
- `program_id` — Program that owns the pool.
- `tick_spacing` — Tick spacing.
- `fee_ppm`, `fee_bps` — **Per‑leg** taker fee (ppm and bps).
- `protocol_fee_ppm` — Protocol share of fees (reported; not added to the above).
- `liquidity_u128` — Current pool liquidity (raw u128).
- `sqrt_price_x64` — Current sqrt(P) in Q64.64.
- `tick_current` — Current tick index.
- `mintA`, `decA`, `symbolA`, `mintB`, `decB`, `symbolB` — Tokens and decimals.
- `base_mint`, `base_decimals`, `base_symbol` — BASE side (usually the non‑USDC asset).
- `quote_mint`, `quote_decimals`, `quote_symbol` — QUOTE side (usually USDC).
- `usd_per_quote` — USD value of 1 unit of quote (1 if quote = USDC).
- `buy_out_base` — BASE received on the BUY leg.
- `sell_in_base` — BASE required on the SELL leg to receive the same USD back.
- `buy_fee_quote` — Fee charged on the BUY input (QUOTE units; USD if quote=USDC).
- `sell_fee_base` — Fee charged on the SELL input (BASE units).

---

## Output anatomy (console)

Each run prints:

1) **Pool Summary** — program id, tick spacing, fee, liquidity, sqrt price, current tick, mints/decimals, **mid**.  
2) **BUY/SELL rows** — for each notional, executed prices, round‑trip bps, fee bps, and implied **impact bps**.

Example:
```
RT   $10,000  mid=208.92686694  buy=209.01064408  sell=208.84312288
      rt=8.0182bps  fee=8.0000bps  impact=0.0182bps
```

---

## What the numbers mean

- **BUY** (`USD→BASE exact‑in`) spends the quote side (USDC) and reports the **executed price** = USD paid / BASE received. Fee is charged on the USD input.
- **SELL** (`BASE→USD exact‑out`) asks for an exact USD amount out and reports the **executed price** = USD received / BASE spent. Fee is charged on the BASE input.
- **Roundtrip bps** includes both fee legs **and** price impact from the curve across ticks used.
- **Impact bps** strips out the fee to isolate liquidity/curve slippage at that size.

---

## Assumptions & limitations

- **USD pools focus.** Accurate USD reporting assumes **USDC** on one side.
- **Single‑pool only.** No routing.
- **Zero slippage tolerance** in SDK quotes (measures pool‑native execution; real trades may add buffers).
- **Large sizes** may cross multiple tick‑arrays; if adjacent arrays are missing/uninitialized via RPC, quotes fail.

---

## License

MIT
