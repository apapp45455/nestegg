// 富邦新一代 API 成交紀錄 → NestEgg 帳本列。純函式，不碰網路也不碰 SDK。
import { addDays } from '../engine/index.js'

export const WINDOW_DAYS = 30 // stock.filledHistory 單次最多查 30 天

// [from, to] 切成每段最多 30 天，格式為 SDK 要的 YYYYMMDD
export function dateWindows(from, to) {
  const out = []
  for (let start = from; start <= to; start = addDays(start, WINDOW_DAYS)) {
    const end = addDays(start, WINDOW_DAYS - 1)
    out.push([start, end < to ? end : to].map(d => d.replaceAll('-', '')))
  }
  return out
}

const ACTIONS = { Buy: 'buy', Sell: 'sell' }
const CASH = ['Stock', 'DayTrade'] // 融資、融券、借券用的不是自己的本金，不算

export const fillsToRows = fills => fills
  .filter(f => ACTIONS[f.buySell] && CASH.includes(f.orderType))
  .map(f => ({
    date: String(f.date).replace(/^(\d{4})\/?(\d{2})\/?(\d{2})$/, '$1-$2-$3'),
    symbol: f.stockNo,
    action: ACTIONS[f.buySell],
    shares: f.filledQty,
    amount: Math.round(f.filledPrice * f.filledQty),
    fee: 0, // ponytail: API 不回傳手續費，本金會略少；要精確請改匯入對帳單 CSV
  }))
