// 永豐金證券 Shioaji 帳務資料 → NestEgg 帳本列。純函式，不碰網路也不碰 Shioaji。
//
// Shioaji 沒有「歷史成交紀錄」查詢（order_deal_records 只有當天），所以從兩個地方拼回來：
// - 還沒賣的：持倉（positions）＋ 每筆持倉的買進明細（position_detail，有買進日期）
// - 已經賣的：已實現損益（profit_loss，賣出那天）＋ 對到的買進明細（profit_loss_detail，有買進日期與價格）
// 持倉是「目前」的快照，賣掉一部分之後數字會變，所以每次同步都重拼一次、取代上次寫進帳本的那批。

const name = v => String(v ?? '').split('.').pop() // 'Cash'；有的版本會輸出 'StockOrderCond.Cash'
const day = d => String(d).replace(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2}).*$/, '$1-$2-$3') // 也接受 20260518、2026/05/18
const isCash = r => name(r.cond) === 'Cash' // 融資、融券用的不是自己的本金，不算

// 明細的 quantity 有的以「張」計、有的以「股」計，依合計的股數換算回股數
function spread(lots, shares) {
  const total = lots.reduce((n, l) => n + Number(l.quantity), 0)
  return total > 0 ? lots.map(l => ({ ...l, shares: Math.round((Number(l.quantity) * shares) / total) })) : []
}

// positions、profitLoss 用 unit=Share 查（數量是股數）；details 以 position / profit_loss 的 id 為 key
export function toRows({ positions = [], positionDetails = {}, profitLoss = [], profitDetails = {} }) {
  const rows = [], warnings = []
  for (const p of positions.filter(p => isCash(p) && name(p.direction) === 'Buy')) {
    const lots = spread(positionDetails[p.id] ?? [], Number(p.quantity))
    if (!lots.length) warnings.push(`${p.code} 查不到買進日期，略過`)
    // 明細的價格單位不一致（有的是每張），一律用持倉的平均成本（每股）
    for (const l of lots) rows.push({ date: day(l.date), symbol: p.code, action: 'buy', shares: l.shares, amount: Math.round(Number(p.price) * l.shares), fee: 0 })
  }
  for (const pl of profitLoss.filter(isCash)) {
    const shares = Number(pl.quantity)
    rows.push({ date: day(pl.date), symbol: pl.code, action: 'sell', shares, amount: Math.round(Number(pl.price) * shares), fee: 0 })
    for (const l of spread(profitDetails[pl.id] ?? [], shares)) {
      rows.push({ date: day(l.date), symbol: pl.code, action: 'buy', shares: l.shares, amount: Math.round(Number(l.price) * l.shares), fee: Number(l.fee) || 0 })
    }
  }
  return { rows: rows.filter(r => r.shares > 0).sort((a, b) => a.date.localeCompare(b.date)), warnings }
}
