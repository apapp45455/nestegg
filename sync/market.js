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
