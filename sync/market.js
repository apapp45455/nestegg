// Public closing data from the TWSE / TPEx OpenAPI → the market object the engine expects. Pure functions.

const rocDate = s => `${Number(s.slice(0, -4)) + 1911}-${s.slice(-4, -2)}-${s.slice(-2)}` // 1151002 → 2026-10-02

// index: MI_INDEX; twse: STOCK_DAY_ALL; tpex: tpex_mainboard_daily_close_quotes (optional)
export function parseMarket(index, twse, tpex = []) {
  const taiex = index.find(r => r['指數'] === '發行量加權股價指數')
  if (!taiex) throw new Error('證交所資料裡找不到加權指數')
  const prices = {}
  const add = (code, close, change) => {
    const c = Number.parseFloat(close) // No trades shows as "--", which becomes NaN and is skipped
    const d = Number.parseFloat(change)
    if (c > 0) prices[String(code).trim()] = { close: c, change: Number.isFinite(d) ? d : 0 }
  }
  for (const r of tpex) add(r.SecuritiesCompanyCode, r.Close, r.Change)
  for (const r of twse) add(r.Code, r.ClosingPrice, r.Change)
  return {
    date: rocDate(taiex['日期']),
    indexChange: (taiex['漲跌'] === '-' ? -1 : 1) * Number.parseFloat(taiex['漲跌百分比']),
    prices,
  }
}

// US market: Nasdaq's screener tables (every listed stock and ETF in one download, like the TWSE table) and TAIFEX's
// daily USD/NTD rate. Prices stay in US dollars; fx converts holdings with shares to NT$.
// Nasdaq writes class shares as BRK/B; ledgers write BRK.B
const ticker = s => String(s).trim().replace('/', '.')
const number = s => Number.parseFloat(String(s).replace(/[$,%]/g, '')) // "$707.5400", "0.73%"; "NA" becomes NaN
const usDate = s => {
  const [m, d, y] = String(s).split(' ')[0].split('/')
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
}

// stocks: /api/screener/stocks rows; etfs: /api/screener/etf data ({ dataAsOf, data: { rows } }); fx: DailyForeignExchangeRates
export function parseUs(stocks, etfs, fx) {
  const prices = {}
  const add = (symbol, close, change) => {
    const c = number(close)
    const d = number(change)
    if (c > 0) prices[ticker(symbol)] = { close: c, change: Number.isFinite(d) ? d : 0 }
  }
  for (const r of stocks) add(r.symbol, r.lastsale, r.netchange)
  for (const r of etfs.data.rows) add(r.symbol, r.lastSalePrice, r.netChange)
  // The weather follows the S&P 500; VOO tracks it and is in the same table, so its change stands in for the index
  const voo = prices.VOO
  if (!voo) throw new Error('Nasdaq 資料裡找不到 VOO')
  const rate = number(fx.at(-1)?.['USD/NTD'])
  if (!(rate > 0)) throw new Error('期交所資料裡找不到美元匯率')
  return {
    date: usDate(etfs.dataAsOf),
    indexChange: Math.round((voo.change / (voo.close - voo.change)) * 10_000) / 100,
    fx: rate,
    prices,
  }
}

// Daily closes from /api/quote/{symbol}/historical (newest first) → [[date, close], …] oldest first.
// An unknown symbol answers without data: that's an empty history, not an error
export function parseHistory(res) {
  return (res?.data?.tradesTable?.rows ?? [])
    .map(r => [usDate(r.date), number(r.close)])
    .filter(([, close]) => close > 0)
    .reverse()
}
