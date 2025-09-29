# CLMM Spreads — Orca & Raydium probes

Lightweight, RPC‑only spread/impact probes for **single pools** on Solana:

- **Orca Whirlpools** (Orca CLMM)
- **Raydium CLMM** (`@raydium-io/raydium-sdk-v2`)

They fetch on‑chain pool state + tick arrays, compute **BUY** (USD→A exact‑in) and **SELL** (A→USD exact‑out) quotes on **that pool only**, then print a summary and optionally produce **CSV files**.

Quotes use **zero slippage tolerance** in the SDK calls. This measures pool‑native execution at size (fee + curve depth), without adding extra user‑side slippage buffers.

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

## Raydium CLMM

### Example: print + CSV for USDC/SOL pool

```bash
node dist/raydium_probe.js \
  --pool 3ucNos4NbumPLZNWztqGHNFFgkHeRMBQAVemeeomsUxv \
  --range 5000:50000:5000 \
  --csv rt_raydium_usdc_sol.csv
```

> Notes
> - Quotes assume **USDC** is on either mint A or B. If not, the script still runs, but "USD per A" will really mean **quote per A** (i.e., mintB per A). The CSV header stays the same to match the Orca schema.

---

## Orca Whirlpools

### Example: print + CSV

```bash
node dist/orca_probe.js \
  --pool Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE \
  --range 5000:50000:5000 \
  --csv rt_orca.csv
```

> Notes
> - Uses the Whirlpool SDK via RPC to pull pool + tick arrays and computes BUY/SELL on the pool.

---

All flags are the same across Orca and Raydium probes.

| Flag | Type | Default | Notes |
|---|---|---:|---|
| `--pool` | `string` | *required* | Pool public key (Whirlpool or Raydium CLMM pool id). |
| `--rpc` | `string` | `https://api.mainnet-beta.solana.com` | Use your own RPC for speed / rate limits. |
| `--sizes` | `comma-list` | `100,1000,5000,10000,100000,1000000` | USD notionals to quote (e.g. `--sizes 100,250,1000`). |
| `--range` | `start:end:step` | *none* | Alternative to `--sizes`. Example: `--range 5000:50000:5000`. |
| `--csv` | `string` | *none* | If set, appends rows to this CSV file using the schema below. |
| `--quiet` | `bool` | `false` | If set, suppresses the console table and only writes CSV rows. |

> You can pass **either** `--sizes` **or** `--range`. If both are provided, `--range` wins.

---


## CSV Schema

## Column semantics
- `ts_utc` — ISO timestamp when the quotes were taken (UTC).
- `pool` — Pool pubkey (Whirlpool or Raydium CLMM id).
- `program_id` — Program id that owns the pool.
- `tick_spacing` — Pool tick spacing.
- `fee_ppm` — Pool taker fee **per leg**, in parts‑per‑million.
- `fee_bps_one_leg` — Same fee expressed in bps for one leg (`fee_ppm / 100`).
- `protocol_fee_ppm` — Protocol cut of the fee in ppm (reported; not deducted from the leg fee fields below).
- `liquidity_u128` — Pool liquidity (raw u128).
- `sqrt_price_x64` — Current sqrt(P) in Q64.64.
- `tick_current` — Current tick index.
- `mintA`, `decA`, `mintB`, `decB` — Token mints and their decimals.
- `quote_mint`, `quote_decimals` — Which side is treated as the **quote** currency (usually USDC) and its decimals.
- `base_mint`, `base_decimals` — The **base** asset and its decimals.
- `usd_per_quote` — USD value of 1 unit of quote (1 if quote = USDC; from oracle if quote ≠ USDC and oracle is provided).
- `mid_usd_per_base` — Mid price in USD per BASE, derived from on‑chain `sqrt_price_x64` (and `usd_per_quote` if needed).
- `usd_notional` — USD size used for the BUY+SELL roundtrip.
- `buy_px_usd_per_base` — Executed BUY price (USD/BASE) for **USD→BASE exact‑in**.
- `sell_px_usd_per_base` — Executed SELL price (USD/BASE) for **BASE→USD exact‑out**.
- `roundtrip_bps` — `(buy_px_usd_per_base / sell_px_usd_per_base − 1) * 1e4`.
- `fee_bps_roundtrip` — `2 × fee_bps_one_leg` (fee each way).
- `impact_bps` — `roundtrip_bps − fee_bps_roundtrip` (AMM curve/tick liquidity component).
- `buy_out_base` — BASE received on the BUY leg.
- `sell_in_base` — BASE required on the SELL leg to receive the same USD amount back.
- `buy_fee_quote` — Fee charged on the BUY input side, in quote units (USD if quote = USDC).
- `sell_fee_base` — Fee charged on the SELL input side, in BASE units.

## Output anatomy (console)

Each run prints:

1) **Pool Summary** – program id, tick spacing, fee, liquidity, sqrt price, mints/decimals, and the **mid**.
2) **Tick‑arrays window** – per array: initialized ticks, Σ(Lgross), Σ(|Lnet|). Helps confirm local depth and whether quotes cross arrays.
3) **BUY/SELL rows** – for each notional, both legs with exec price, fee bps, impact bps, and the tick‑arrays actually used.

Use `--quiet` to suppress the pretty table when you only want CSV appends.

---
