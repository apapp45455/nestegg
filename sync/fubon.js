// Fubon next-generation API data → NestEgg ledger rows. Pure functions; no network, no SDK.
// Two sources: the trade history (stock.filledHistory, needs the 證券下單 order permission, used once to import the past)
// and the current holdings (accounting.unrealizedGainsAndLoses, needs only 證券業務), reconciled every day.
import { addDays, holdings } from '../engine/index.js'

export const WINDOW_DAYS = 30 // stock.filledHistory covers at most 30 days per query

// Split [from, to] into windows of at most 30 days, formatted as the SDK's YYYYMMDD
export function dateWindows(from, to) {
  const out = []
  for (let start = from; start <= to; start = addDays(start, WINDOW_DAYS)) {
    const end = addDays(start, WINDOW_DAYS - 1)
    out.push([start, end < to ? end : to].map(d => d.replaceAll('-', '')))
  }
  return out
}

const ACTIONS = { Buy: 'buy', Sell: 'sell' }
const CASH = ['Stock', 'DayTrade'] // Margin buying, short selling and securities lending don't use the user's own principal, so they don't count

export const fillsToRows = fills => fills
  .filter(f => ACTIONS[f.buySell] && CASH.includes(f.orderType))
  .map(f => ({
    date: String(f.date).replace(/^(\d{4})\/?(\d{2})\/?(\d{2})$/, '$1-$2-$3'),
    symbol: f.stockNo,
    action: ACTIONS[f.buySell],
    shares: f.filledQty,
    amount: Math.round(f.filledPrice * f.filledQty),
    fee: 0, // ponytail: the API returns no fees, so principal is slightly low; import the statement CSV for exact numbers
  }))

// Cash holdings from accounting.unrealizedGainsAndLoses, summed across accounts: symbol → { shares, cost }.
// Margin and short positions don't use the user's own principal, so they don't count (same as CASH above).
// Unreadable numbers stop the sync: a wrong holding would be recorded as a buy or a sell.
export function positionsOf(assets) {
  const out = {}
  for (const a of assets.filter(a => a.orderType === 'Stock')) {
    if (!Number.isInteger(a.todayQty) || a.todayQty < 0 || !(a.costPrice >= 0)) throw new Error(`看不懂富邦回傳的 ${a.stockNo} 持股資料，先不更新帳本`)
    const p = (out[a.stockNo] ??= { shares: 0, cost: 0 })
    p.shares += a.todayQty
    p.cost += a.costPrice * a.todayQty
  }
  return out
}

// Compare the broker's holdings with what the sync has recorded so far (`owned` ledger rows) and return the rows that
// close the gap, dated today: more shares → a buy at the added cost; fewer → a sell at the recorded average cost
// (selling doesn't change the remaining principal either way).
// ponytail: the date is when NestEgg notices the change, so it's later if the computer was off; exact dates need filledHistory
export function reconcile(positions, owned, today) {
  const recorded = holdings(owned, today)
  const rows = []
  for (const symbol of new Set([...Object.keys(positions), ...recorded.keys()])) {
    const now = positions[symbol] ?? { shares: 0, cost: 0 }
    const was = recorded.get(symbol) ?? { shares: 0, cost: 0 }
    const diff = now.shares - was.shares
    if (diff > 0) {
      const added = now.cost - was.cost // falls back to the average cost if the recorded cost is somehow higher
      rows.push({ date: today, symbol, action: 'buy', shares: diff, amount: Math.round(added > 0 ? added : (diff * now.cost) / now.shares), fee: 0 })
    } else if (diff < 0) {
      rows.push({ date: today, symbol, action: 'sell', shares: -diff, amount: Math.round((-diff * was.cost) / was.shares), fee: 0 })
    }
  }
  return rows
}
