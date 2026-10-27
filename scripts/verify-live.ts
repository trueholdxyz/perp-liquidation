// Checks the formulas against the liquidation prices Hyperliquid and Lighter report for real,
// currently open positions. Accounts are sampled from each venue's recent public trades.
//
//   npm run verify            60 positions per venue
//   npm run verify -- 150     150 per venue
//
// A position counts as a match when both prices agree within 0.01%, or when neither venue nor
// formula has a liquidation price (a hedged or over-collateralised position).

import {
    fetchClearinghouseState,
    fetchHyperliquidMarkets,
    fetchLighterAccount,
    fetchLighterMarkets,
    hyperliquidLiquidation,
    lighterLiquidation,
    HYPERLIQUID_INFO,
    LIGHTER_API,
} from '../src/index.js'

const TARGET = Number(process.argv[2]) || 60
const TOLERANCE = 1e-4
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Row {
    venue: string
    account: string
    market: string
    mode: string
    ours: number | null
    reported: number | null
    /** Hyperliquid account that counts spot balances as margin: out of this package's scope. */
    spotMargin?: boolean
}

const matches = (r: Row) =>
    r.ours === null || r.reported === null ? r.ours === r.reported : Math.abs(r.ours - r.reported) / r.reported <= TOLERANCE

async function hyperliquid(): Promise<Row[]> {
    const markets = await fetchHyperliquidMarkets()
    const users = new Set<string>()
    for (const coin of ['BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'DOGE', 'SUI', 'ENA', 'FARTCOIN', 'kPEPE']) {
        const res = await fetch(HYPERLIQUID_INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'recentTrades', coin }) })
        if (!res.ok) continue
        for (const t of (await res.json()) as { users: string[] }[]) t.users.forEach((u) => users.add(u))
    }
    const rows: Row[] = []
    for (const user of users) {
        if (rows.length >= TARGET) break
        const state = await fetchClearinghouseState(user).catch(() => null)
        if (!state) continue
        // Unified and portfolio-margin accounts also count spot balances as margin, which this
        // package does not model; they are reported apart instead of being counted as misses.
        const abstraction = await fetch(HYPERLIQUID_INFO, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'userAbstraction', user }) })
            .then((r) => r.json() as Promise<string>)
            .catch(() => 'unknown')
        const spotMargin = abstraction === 'unifiedAccount' || abstraction === 'portfolioMargin'
        for (const a of state.assetPositions) {
            if (rows.length >= TARGET) break
            const r = hyperliquidLiquidation(state, a.position.coin, markets)
            if (r) rows.push({ venue: 'Hyperliquid', account: user, market: r.coin, mode: spotMargin ? `${r.marginMode}, ${abstraction}` : r.marginMode, ours: r.price, reported: r.reported, spotMargin })
        }
        await sleep(100)
    }
    return rows
}

async function lighter(): Promise<Row[]> {
    const markets = await fetchLighterMarkets()
    const accounts = new Set<number>()
    for (const id of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
        const res = await fetch(`${LIGHTER_API}/recentTrades?market_id=${id}&limit=50`)
        if (!res.ok) continue
        const { trades } = (await res.json()) as { trades?: { ask_account_id: number; bid_account_id: number }[] }
        for (const t of trades ?? []) {
            accounts.add(t.ask_account_id)
            accounts.add(t.bid_account_id)
        }
        await sleep(300)
    }
    const rows: Row[] = []
    for (const index of accounts) {
        if (rows.length >= TARGET) break
        const account = await fetchLighterAccount(index).catch(() => null)
        await sleep(300)
        if (!account) continue
        for (const p of account.positions) {
            if (rows.length >= TARGET) break
            if (!Number(p.position)) continue
            const r = lighterLiquidation(account, p.market_id, markets)
            if (r) rows.push({ venue: 'Lighter', account: String(index), market: r.symbol, mode: r.marginMode, ours: r.partial, reported: r.reported })
        }
    }
    return rows
}

const fmt = (x: number | null) => (x === null ? '—' : x.toPrecision(8))

for (const [name, run] of [['Hyperliquid', hyperliquid], ['Lighter', lighter]] as const) {
    const all = await run()
    const rows = all.filter((r) => !r.spotMargin)
    const ok = rows.filter(matches)
    console.log(`\n${name}: ${ok.length} of ${rows.length} positions match within ${TOLERANCE * 100}%`)
    const skipped = all.length - rows.length
    if (skipped) console.log(`  (${skipped} more in accounts that count spot balances as margin, not modelled: ${all.filter((r) => r.spotMargin && matches(r)).length} match anyway)`)
    for (const r of rows.filter((x) => !matches(x))) {
        console.log(`  differs  ${r.market.padEnd(10)} ${r.mode.padEnd(8)} ours ${fmt(r.ours)}  reported ${fmt(r.reported)}  account ${r.account}`)
    }
}
