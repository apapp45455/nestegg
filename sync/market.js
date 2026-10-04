// 證交所／櫃買中心 OpenAPI 的公開收盤資料 → 引擎要的 market 物件。純函式。

const rocDate = s => `${Number(s.slice(0, -4)) + 1911}-${s.slice(-4, -2)}-${s.slice(-2)}` // 1151002 → 2026-10-02

// index: MI_INDEX；twse: STOCK_DAY_ALL；tpex: tpex_mainboard_daily_close_quotes（可省略）
export function parseMarket(index, twse, tpex = []) {
  const taiex = index.find(r => r['指數'] === '發行量加權股價指數')
  if (!taiex) throw new Error('證交所資料裡找不到加權指數')
  const prices = {}
  const add = (code, close, change) => {
    const c = Number.parseFloat(close) // 沒成交是 "--"，會變 NaN 被略過
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
