// Fubon next-generation API trade records → NestEgg ledger rows. Pure functions; no network, no SDK.
import { addDays } from '../engine/index.js'

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
