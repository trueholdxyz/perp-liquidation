import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    buildTiers,
    hyperliquidLiquidation,
    lighterLiquidation,
    tieredMaintenance,
    type ClearinghouseState,
    type HyperliquidMarket,
    type LighterAccount,
    type LighterMarket,
} from '../src/index.js'

test('Hyperliquid cross: equity at the price equals total maintenance', () => {
    const btc: HyperliquidMarket = { coin: 'BTC', maxLeverage: 40, tiers: buildTiers([{ lowerBound: 0, maxLeverage: 40 }]), mark: 80_000, funding: 0 }
    const eth: HyperliquidMarket = { coin: 'ETH', maxLeverage: 25, tiers: buildTiers([{ lowerBound: 0, maxLeverage: 25 }]), mark: 2_400, funding: 0 }
    const markets = new Map([['BTC', btc], ['ETH', eth]])
    const ethMaint = tieredMaintenance(10 * 2_400, eth.tiers)
    const state: ClearinghouseState = {
        crossMarginSummary: { accountValue: '20000' },
        crossMaintenanceMarginUsed: String(tieredMaintenance(2 * 80_000, btc.tiers) + ethMaint),
        assetPositions: [
            { position: { coin: 'BTC', szi: '2', positionValue: '160000', leverage: { type: 'cross', value: 10 }, liquidationPx: null } },
            { position: { coin: 'ETH', szi: '-10', positionValue: '24000', leverage: { type: 'cross', value: 10 }, liquidationPx: null } },
        ],
    }
    const r = hyperliquidLiquidation(state, 'BTC', markets)!
    assert.equal(r.side, 1)
    const eq = 20_000 + (r.price! - 80_000) * 2
    const mm = ethMaint + tieredMaintenance(2 * r.price!, btc.tiers)
    assert.ok(Math.abs(eq - mm) < 1e-6)
})

test('Lighter: the LLP takes over further away than partial liquidation starts', () => {
    const markets = new Map<number, LighterMarket>([[1, { marketId: 1, symbol: 'BTC', imf: 0.02, mmf: 0.012, cmf: 0.008, mark: 80_000 }]])
    const account: LighterAccount = {
        cross_asset_value: '10000',
        cross_maintenance_margin_requirement: String(0.012 * 80_000),
        positions: [
            { market_id: 1, symbol: 'BTC', sign: 1, position: '1', position_value: '80000', unrealized_pnl: '0', liquidation_price: '0', margin_mode: 0, allocated_margin: '0' },
        ],
    }
    const r = lighterLiquidation(account, 1, markets)!
    assert.ok(r.partial !== null && r.full !== null)
    assert.ok(r.full < r.partial, 'a long is fully liquidated below the partial price')
    // Single cross position: partial = (mark − equity) / (1 − mmf) for size 1.
    assert.ok(Math.abs(r.partial - (80_000 - 10_000) / (1 - 0.012)) < 1e-6)
})
