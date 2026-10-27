// Hyperliquid: margin tables from the public info API and liquidation prices for open positions.
//
// Maintenance margin is half the initial margin at a coin's maximum leverage, per margin tier
// (see core.ts). Hyperliquid documents the liquidation price as
//   liq_price = price − side · margin_available / position_size / (1 − l · side)
// with l = 1 / maintenance leverage, which is the core equation with
//   isolated: equity = rawUsd + szi · mark
//   cross:    equity = account value, other maintenance = cross maintenance used − own.

import { buildTiers, tieredLiquidationPrice, tieredMaintenance, type Side, type Tier } from './core.js'

export const HYPERLIQUID_INFO = 'https://api.hyperliquid.xyz/info'

export interface HyperliquidMarket {
    coin: string
    maxLeverage: number
    tiers: Tier[]
    mark: number
    /** Current funding rate per hour, as a fraction. */
    funding: number
}

type Fetch = typeof fetch

async function info<T>(body: unknown, f: Fetch = fetch): Promise<T> {
    const res = await f(HYPERLIQUID_INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    if (!res.ok) throw new Error(`Hyperliquid ${res.status}`)
    return (await res.json()) as T
}

interface MetaUniverse {
    name: string
    maxLeverage: number
    marginTableId: number
    isDelisted?: boolean
}
type MarginTables = [number, { marginTiers: { lowerBound: string; maxLeverage: number }[] }][]

/** Every listed perp on Hyperliquid's main dex, keyed by coin. */
export async function fetchHyperliquidMarkets(f: Fetch = fetch): Promise<Map<string, HyperliquidMarket>> {
    const [meta, ctxs] = await info<[{ universe: MetaUniverse[]; marginTables: MarginTables }, { markPx: string; funding: string }[]]>(
        { type: 'metaAndAssetCtxs' },
        f,
    )
    const tables = new Map(meta.marginTables.map(([id, t]) => [id, t.marginTiers.map((x) => ({ lowerBound: Number(x.lowerBound), maxLeverage: x.maxLeverage }))]))
    const out = new Map<string, HyperliquidMarket>()
    meta.universe.forEach((u, n) => {
        if (u.isDelisted) return
        // Margin tables exist only for coins with tiers; any other id is one tier at max leverage.
        const specs = tables.get(u.marginTableId) ?? [{ lowerBound: 0, maxLeverage: u.maxLeverage }]
        out.set(u.name, { coin: u.name, maxLeverage: u.maxLeverage, tiers: buildTiers(specs), mark: Number(ctxs[n].markPx), funding: Number(ctxs[n].funding) })
    })
    return out
}

/** The parts of `clearinghouseState` this package reads. */
export interface ClearinghouseState {
    crossMarginSummary: { accountValue: string }
    crossMaintenanceMarginUsed: string
    assetPositions: {
        position: {
            coin: string
            szi: string
            /** |szi| · mark at the time of the snapshot. */
            positionValue: string
            leverage: { type: 'cross' | 'isolated'; value: number; rawUsd?: string }
            liquidationPx: string | null
        }
    }[]
}

export function fetchClearinghouseState(user: string, f: Fetch = fetch): Promise<ClearinghouseState> {
    return info<ClearinghouseState>({ type: 'clearinghouseState', user }, f)
}

export interface PositionLiquidation {
    coin: string
    side: Side
    size: number
    mark: number
    marginMode: 'cross' | 'isolated'
    /** Mark price at which the position is liquidated; null when there is none above zero. */
    price: number | null
    tier: Tier
    /** The price Hyperliquid itself reports, for comparison. */
    reported: number | null
}

/**
 * Liquidation price of `coin` in a Hyperliquid account. Accounts that also count spot balances
 * as margin (unified accounts) are liquidated further away than this returns.
 */
export function hyperliquidLiquidation(state: ClearinghouseState, coin: string, markets: Map<string, HyperliquidMarket>): PositionLiquidation | null {
    const ap = state.assetPositions.find((a) => a.position.coin === coin)
    const market = markets.get(coin)
    if (!ap || !market) return null
    const p = ap.position
    const szi = Number(p.szi)
    if (!szi) return null
    const side: Side = szi > 0 ? 1 : -1
    const size = Math.abs(szi)
    const { tiers } = market
    // The mark the account snapshot was valued at, so equity and price come from the same moment.
    const mark = Number(p.positionValue) / size || market.mark
    let equity: number
    let otherMaintenance = 0
    if (p.leverage.type === 'isolated') {
        equity = Number(p.leverage.rawUsd) + szi * mark
    } else {
        equity = Number(state.crossMarginSummary.accountValue)
        otherMaintenance = Number(state.crossMaintenanceMarginUsed) - tieredMaintenance(size * mark, tiers)
    }
    const { price, tier } = tieredLiquidationPrice({ side, mark, size, equity, otherMaintenance }, tiers)
    const reported = p.liquidationPx === null ? null : Number(p.liquidationPx)
    return { coin, side, size, mark, marginMode: p.leverage.type, price, tier, reported: reported && reported > 0 ? reported : null }
}

/** Fetches markets and the account, then computes every open position's liquidation price. */
export async function fetchHyperliquidLiquidations(user: string, f: Fetch = fetch): Promise<PositionLiquidation[]> {
    const [markets, state] = await Promise.all([fetchHyperliquidMarkets(f), fetchClearinghouseState(user, f)])
    return state.assetPositions.map((a) => hyperliquidLiquidation(state, a.position.coin, markets)).filter((x): x is PositionLiquidation => x !== null)
}
