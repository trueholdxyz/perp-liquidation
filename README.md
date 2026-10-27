# perp-liquidation

Liquidation prices for perpetual futures, in TypeScript, with no dependencies. The library uses one equation for isolated and cross margin. It handles Hyperliquid's margin tiers and both of Lighter's liquidation thresholds.

This is the math behind the [liquidation price calculators on TrueHold](https://www.truehold.xyz/calculators/liquidation-price). A script in this repo checks it against the prices the exchanges themselves report for live positions. Here is the latest run, 27 October 2026:

| Venue | Positions checked | Match within 0.01% |
|---|---|---|
| Hyperliquid (standard accounts) | 74 | 74 |
| Lighter | 100 | 100 |

Run it yourself with `npm run verify`.

## Install

```sh
npm install perp-liquidation
```

Node 18 or newer, or any runtime with `fetch`. The core functions are pure and run anywhere, including the browser.

## The equation

At mark price `P` a position's equity is `equity + side · (P − mark) · size`. The venue liquidates once that equity falls to the maintenance requirement, `otherMaintenance + rate · P · size − deduction`. Solving for `P`:

```
P = (side · mark · size − equity + otherMaintenance − deduction) / ((side − rate) · size)
```

`side` is 1 for a long and −1 for a short. For a fresh isolated position at leverage `L` this reduces to the familiar forms:

```
long  = entry · (1 − 1/L) / (1 − rate)
short = entry · (1 + 1/L) / (1 + rate)
```

## Usage

### Any venue

```ts
import { isolatedLiquidationPrice, liquidationPrice } from 'perp-liquidation'

// 20x long on BTC from 100,000 with a 1.25% maintenance margin
isolatedLiquidationPrice(1, 100_000, 20, 0.0125) // ≈ 96,203

// Cross account: 2 BTC long at mark 80,000, $20,000 account value,
// $960 of maintenance already used by other positions
liquidationPrice({ side: 1, mark: 80_000, size: 2, equity: 20_000, rate: 0.0125, otherMaintenance: 960 }) // ≈ 71,372
```

A function returns `null` when no liquidation price exists above zero. A fully collateralised long is one example.

### Hyperliquid

```ts
import { fetchHyperliquidLiquidations } from 'perp-liquidation'

const positions = await fetchHyperliquidLiquidations('0xYourAddress')
// [{ coin, side, size, mark, marginMode, price, tier, reported }, ...]
// `reported` is Hyperliquid's own figure, handy as a cross-check.
```

The library reads margin tables and marks from the public `metaAndAssetCtxs` endpoint and the account from `clearinghouseState`. No key is needed. The maintenance rate of each tier is `1 / (2 · maxLeverage)`, and a cumulative deduction keeps the requirement continuous across tiers. The tier that counts is the one matching the position's value *at the liquidation price*. `tieredLiquidationPrice` solves for each tier and keeps the self-consistent answer.

To work from data you already have, use `fetchHyperliquidMarkets()` once and then call `hyperliquidLiquidation(state, coin, markets)`.

### Lighter

```ts
import { fetchLighterLiquidations } from 'perp-liquidation'

const positions = await fetchLighterLiquidations(accountIndex)
// [{ symbol, side, size, mark, marginMode, partial, full, reported }, ...]
```

Each Lighter market sets three margin fractions: initial, maintenance and close-out. They arrive from `orderBookDetails` in hundredths of a percent. Below maintenance, *partial* liquidation starts. Below close-out, the LLP takes over the rest, which is the *full* price. The price Lighter reports is the partial one.

## Limits

- **Hyperliquid unified and portfolio-margin accounts** count spot balances as margin, so they are liquidated further away than this library computes. The verify script detects them with `userAbstraction` and reports them separately.
- **Lighter's full liquidation price** is derived from the close-out fractions. Lighter does not publish it, so it cannot be checked against the venue the way the partial price is.
- **Funding and fees** move the liquidation price after you open. Funding is settled hourly on both venues. This library prices the position as it stands now.
- Hyperliquid's builder-deployed (HIP-3) markets are not covered.

## Calculators and guides

- [Liquidation price calculator](https://www.truehold.xyz/calculators/liquidation-price)
- [Hyperliquid liquidation calculator](https://www.truehold.xyz/calculators/liquidation-price/hyperliquid), which reads each coin's margin tiers
- [Lighter liquidation calculator](https://www.truehold.xyz/calculators/liquidation-price/lighter), with partial and full prices
- [Funding rate calculator](https://www.truehold.xyz/calculators/funding-rate)
- [How liquidation works on Hyperliquid and Lighter](https://www.truehold.xyz/blog/how-liquidation-works-hyperliquid-lighter)

## License

MIT. Maintained by [TrueHold](https://www.truehold.xyz).
