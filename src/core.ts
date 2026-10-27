// Liquidation price math for linear (USD-margined) perpetual futures.
//
// One equation covers every venue in this package. At mark price P the position's equity is
//   equity(P) = equity + side · (P − mark) · size
// and the venue liquidates once that equity falls to the maintenance requirement
//   maintenance(P) = otherMaintenance + rate · P · size − deduction
// Solving equity(P) = maintenance(P) for P:
//   P = (side · mark · size − equity + otherMaintenance − deduction) / ((side − rate) · size)
//
// For a fresh isolated position opened at `entry` with leverage L this reduces to the
// familiar forms: long = entry · (1 − 1/L) / (1 − rate), short = entry · (1 + 1/L) / (1 + rate).

/** 1 for a long, −1 for a short. */
export type Side = 1 | -1

export interface LiquidationInput {
    side: Side
    /** Mark price the equity below is measured at (the entry price for a new position). */
    mark: number
    /** Position size in coins, always positive. */
    size: number
    /** Equity backing the position at `mark`: isolated margin, or cross account value. */
    equity: number
    /** Maintenance margin rate as a fraction (0.0125 for 1.25%). */
    rate: number
    /** Maintenance deduction in USD, for tiered venues; 0 elsewhere. */
    deduction?: number
    /** Maintenance margin already required by other positions in a cross account. */
    otherMaintenance?: number
}

/**
 * Mark price at which the position reaches its maintenance requirement.
 * Returns null when there is no such price above zero (a long that cannot be liquidated).
 */
export function liquidationPrice(i: LiquidationInput): number | null {
    const { side, mark, size, equity, rate } = i
    const deduction = i.deduction ?? 0
    const other = i.otherMaintenance ?? 0
    if (!(mark > 0) || !(size > 0) || !(rate >= 0) || !Number.isFinite(equity)) return null
    const p = (side * mark * size - equity + other - deduction) / ((side - rate) * size)
    if (!Number.isFinite(p) || p <= 0) return null
    return p
}

/** Isolated position opened at `entry` with leverage `leverage` and maintenance rate `rate`. */
export function isolatedLiquidationPrice(side: Side, entry: number, leverage: number, rate: number): number | null {
    if (!(entry > 0) || !(leverage > 0)) return null
    return liquidationPrice({ side, mark: entry, size: 1, equity: entry / leverage, rate })
}

// --------------------------------------------------------------------------------------------
// Tiered maintenance (Hyperliquid margin tables)
//
// maintenance_margin = notional · rate(tier) − deduction(tier), where
//   rate(tier n) = initial margin rate at the tier's max leverage / 2 = 1 / (2 · maxLeverage)
//   deduction(0) = 0
//   deduction(n) = deduction(n − 1) + lowerBound(n) · (rate(n) − rate(n − 1))
// which keeps total maintenance margin continuous in position size. The tier that applies is
// the one matching the position value at the liquidation price.

export interface TierSpec {
    /** Notional position value (USD) where the tier starts. */
    lowerBound: number
    maxLeverage: number
}

export interface Tier extends TierSpec {
    rate: number
    deduction: number
}

export function buildTiers(specs: TierSpec[]): Tier[] {
    const sorted = [...specs].sort((a, b) => a.lowerBound - b.lowerBound)
    const tiers: Tier[] = []
    sorted.forEach((s, n) => {
        const rate = 1 / (2 * s.maxLeverage)
        const deduction = n === 0 ? 0 : tiers[n - 1].deduction + s.lowerBound * (rate - tiers[n - 1].rate)
        tiers.push({ ...s, rate, deduction })
    })
    return tiers
}

/** The tier a notional position value falls into. */
export function tierFor(notional: number, tiers: Tier[]): Tier {
    let t = tiers[0]
    for (const tier of tiers) if (notional >= tier.lowerBound) t = tier
    return t
}

/** Maintenance margin of a position worth `notional` USD under tiered rules. */
export function tieredMaintenance(notional: number, tiers: Tier[]): number {
    const t = tierFor(notional, tiers)
    return notional * t.rate - t.deduction
}

/**
 * Liquidation price with tiered maintenance: solve once per tier and keep the solution whose
 * notional at the liquidation price lands inside that same tier.
 */
export function tieredLiquidationPrice(
    i: Omit<LiquidationInput, 'rate' | 'deduction'>,
    tiers: Tier[],
): { price: number | null; tier: Tier } {
    for (let n = 0; n < tiers.length; n++) {
        const tier = tiers[n]
        const price = liquidationPrice({ ...i, rate: tier.rate, deduction: tier.deduction })
        if (price === null) continue
        const notional = price * i.size
        const upper = n + 1 < tiers.length ? tiers[n + 1].lowerBound : Infinity
        if (notional >= tier.lowerBound && notional < upper) return { price, tier }
    }
    // No self-consistent tier (only at the zero-price edge): report the tier at the current mark.
    const tier = tierFor(i.mark * i.size, tiers)
    return { price: liquidationPrice({ ...i, rate: tier.rate, deduction: tier.deduction }), tier }
}

/** Signed distance from `from` to `to` as a fraction of `from` (−0.1 is 10% lower). */
export function distance(from: number, to: number): number {
    return (to - from) / from
}
