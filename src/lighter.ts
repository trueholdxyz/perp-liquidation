// Lighter: margin fractions from the public API and the two liquidation prices of a position.
//
// Every Lighter market sets three fractions of position value: initial, maintenance and
// close-out. Below maintenance, partial liquidation starts (orders cancelled, positions closed
// through the book); below close-out, the LLP takes over what is left. Both thresholds are the
// core equation with their own rate. The liquidation price Lighter reports is the partial one.

import { liquidationPrice, type Side } from './core.js'

export const LIGHTER_API = 'https://mainnet.zklighter.elliot.ai/api/v1'

export interface LighterMarket {
    marketId: number
    symbol: string
    /** Fractions: 0.02 for 2%. Lowest initial margin, so max leverage = 1 / imf. */
    imf: number
    mmf: number
    cmf: number
    mark: number
}

type Fetch = typeof fetch

async function get<T>(path: string, f: Fetch = fetch): Promise<T> {
    const res = await f(`${LIGHTER_API}${path}`)
    if (!res.ok) throw new Error(`Lighter ${res.status}`)
    return (await res.json()) as T
}

/** Active perp markets, keyed by market id. Fractions arrive in hundredths of a percent. */
export async function fetchLighterMarkets(f: Fetch = fetch): Promise<Map<number, LighterMarket>> {
    const { order_book_details: rows } = await get<{
        order_book_details: {
            market_id: number
            symbol: string
            status: string
            market_type: string
            mark_price?: number | string
            last_trade_price: number | string
            min_initial_margin_fraction: number
            maintenance_margin_fraction: number
            closeout_margin_fraction: number
        }[]
    }>('/orderBookDetails', f)
    const out = new Map<number, LighterMarket>()
    for (const m of rows) {
        if (m.status !== 'active' || m.market_type !== 'perp') continue
        out.set(m.market_id, {
            marketId: m.market_id,
            symbol: m.symbol,
            imf: m.min_initial_margin_fraction / 10000,
            mmf: m.maintenance_margin_fraction / 10000,
            cmf: m.closeout_margin_fraction / 10000,
            mark: Number(m.mark_price ?? m.last_trade_price),
        })
    }
    return out
}

/** The parts of an `account` response this package reads. */
export interface LighterAccount {
    cross_asset_value: string
    cross_maintenance_margin_requirement: string
    positions: {
        market_id: number
        symbol: string
        sign: number
        position: string
        position_value: string
        unrealized_pnl: string
        liquidation_price: string
        /** 0 cross, 1 isolated. */
        margin_mode: number
        allocated_margin: string
    }[]
}

export async function fetchLighterAccount(index: number | string, f: Fetch = fetch): Promise<LighterAccount> {
    const { accounts } = await get<{ accounts: LighterAccount[] }>(`/account?by=index&value=${index}`, f)
    if (!accounts?.length) throw new Error(`Lighter account ${index} not found`)
    return accounts[0]
}

export interface LighterLiquidation {
    marketId: number
    symbol: string
    side: Side
    size: number
    mark: number
    marginMode: 'cross' | 'isolated'
    /** Partial liquidation starts here (maintenance margin). */
    partial: number | null
    /** The LLP takes over here (close-out margin). */
    full: number | null
    /** The price Lighter itself reports, which is the partial one. */
    reported: number | null
}

/** Both liquidation prices of the position in `marketId`. */
export function lighterLiquidation(account: LighterAccount, marketId: number, markets: Map<number, LighterMarket>): LighterLiquidation | null {
    const pos = account.positions.find((p) => p.market_id === marketId)
    const market = markets.get(marketId)
    if (!pos || !market) return null
    const size = Number(pos.position)
    if (!size) return null
    const side: Side = pos.sign < 0 ? -1 : 1
    const value = Number(pos.position_value)
    const mark = value / size
    const isolated = pos.margin_mode === 1
    let equity: number
    let otherMaintenance = 0
    let otherCloseout = 0
    if (isolated) {
        // Lighter keeps an isolated position in its own sub-balance.
        equity = Number(pos.allocated_margin) + Number(pos.unrealized_pnl)
    } else {
        equity = Number(account.cross_asset_value)
        otherMaintenance = Number(account.cross_maintenance_margin_requirement) - market.mmf * value
        for (const p of account.positions) {
            if (p.market_id === marketId || p.margin_mode === 1 || !Number(p.position)) continue
            otherCloseout += (markets.get(p.market_id)?.cmf ?? 0) * Number(p.position_value)
        }
    }
    const partial = liquidationPrice({ side, mark, size, equity, rate: market.mmf, otherMaintenance })
    const full = liquidationPrice({ side, mark, size, equity, rate: market.cmf, otherMaintenance: otherCloseout })
    const reported = Number(pos.liquidation_price)
    return {
        marketId,
        symbol: market.symbol,
        side,
        size,
        mark,
        marginMode: isolated ? 'isolated' : 'cross',
        partial,
        full,
        reported: reported > 0 ? reported : null,
    }
}

/** Fetches markets and the account, then computes both prices for every open position. */
export async function fetchLighterLiquidations(index: number | string, f: Fetch = fetch): Promise<LighterLiquidation[]> {
    const [markets, account] = await Promise.all([fetchLighterMarkets(f), fetchLighterAccount(index, f)])
    return account.positions
        .filter((p) => Number(p.position))
        .map((p) => lighterLiquidation(account, p.market_id, markets))
        .filter((x): x is LighterLiquidation => x !== null)
}
