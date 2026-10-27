import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
    buildTiers,
    distance,
    isolatedLiquidationPrice,
    liquidationPrice,
    tieredLiquidationPrice,
    tieredMaintenance,
    type Side,
} from '../src/index.js'

const close = (a: number | null, b: number, eps = 1e-9) => {
    assert.ok(a !== null, 'expected a price')
    assert.ok(Math.abs(a - b) <= eps * Math.max(1, Math.abs(b)), `${a} ≠ ${b}`)
}

test('isolated long and short match the closed forms', () => {
    close(isolatedLiquidationPrice(1, 100, 10, 0.005), (100 * (1 - 1 / 10)) / (1 - 0.005))
    close(isolatedLiquidationPrice(-1, 100, 10, 0.005), (100 * (1 + 1 / 10)) / (1 + 0.005))
})

test('BTC on Hyperliquid at 40x: maintenance 1.25%', () => {
    // 1 / (2 · 40) = 1.25%; a 20x long from 100,000 is liquidated about 3.8% lower.
    const p = isolatedLiquidationPrice(1, 100_000, 20, 1 / 80)
    close(p, (100_000 * (1 - 1 / 20)) / (1 - 1 / 80))
    assert.ok(Math.abs(distance(100_000, p!) + 0.038) < 0.001)
})

test('a fully collateralised long cannot be liquidated', () => {
    assert.equal(isolatedLiquidationPrice(1, 100, 1, 0.01), null)
    assert.equal(liquidationPrice({ side: 1, mark: 100, size: 1, equity: 150, rate: 0.01 }), null)
})

test('at the liquidation price, equity equals the maintenance requirement', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let n = 0; n < 500; n++) {
        const side: Side = rnd() < 0.5 ? 1 : -1
        const mark = 1 + rnd() * 100_000
        const size = 0.001 + rnd() * 50
        const equity = mark * size * (0.02 + rnd() * 0.5)
        const rate = 0.001 + rnd() * 0.05
        const otherMaintenance = rnd() < 0.5 ? 0 : mark * size * rnd() * 0.01
        const p = liquidationPrice({ side, mark, size, equity, rate, otherMaintenance })
        if (p === null) continue
        const eq = equity + side * (p - mark) * size
        const mm = otherMaintenance + rate * p * size
        assert.ok(Math.abs(eq - mm) < 1e-6 * mark * size, `case ${n}`)
    }
})

test('tiered maintenance is continuous at every tier boundary', () => {
    const tiers = buildTiers([
        { lowerBound: 0, maxLeverage: 40 },
        { lowerBound: 150_000_000, maxLeverage: 20 },
        { lowerBound: 300_000_000, maxLeverage: 10 },
    ])
    for (const t of tiers.slice(1)) {
        const below = tieredMaintenance(t.lowerBound - 1e-6, tiers)
        const at = tieredMaintenance(t.lowerBound, tiers)
        assert.ok(Math.abs(below - at) < 1e-3, `jump at ${t.lowerBound}`)
    }
})

test('tiered liquidation lands inside the tier it was solved with', () => {
    const tiers = buildTiers([
        { lowerBound: 0, maxLeverage: 50 },
        { lowerBound: 1_000_000, maxLeverage: 20 },
        { lowerBound: 5_000_000, maxLeverage: 10 },
    ])
    const { price, tier } = tieredLiquidationPrice({ side: 1, mark: 100, size: 40_000, equity: 600_000 }, tiers)
    assert.ok(price !== null)
    const notional = price * 40_000
    assert.ok(notional >= tier.lowerBound)
    assert.equal(tier.maxLeverage, 20)
})
