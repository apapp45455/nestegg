// 永豐金證券 Shioaji 帳務資料 → NestEgg 帳本列。純函式，不碰網路也不碰 Shioaji。
//
// Shioaji 沒有「歷史成交紀錄」查詢（order_deal_records 只有當天），所以從兩個地方拼回來：
// - 還沒賣的：持倉（positions）＋ 每筆持倉的買進明細（position_detail，有買進日期）
// - 已經賣的：已實現損益（profit_loss，賣出那天）＋ 對到的買進明細（profit_loss_detail，有買進日期與價格）
// 持倉是「目前」的快照，賣掉一部分之後數字會變，所以每次同步都重拼一次、取代上次寫進帳本的那批。
import { isDate } from '../engine/index.js'

const name = v => String(v ?? '').split('.').pop() // 'Cash'；有的版本會輸出 'StockOrderCond.Cash'
const day = d => String(d).replace(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2}).*$/, '$1-$2-$3') // 也接受 20260518、2026/05/18
const isCash = r => name(r.cond) === 'Cash' // 融資、融券用的不是自己的本金，不算

// 明細的 quantity 有的以「張」計、有的以「股」計，依合計的股數換算回股數。
// 前面幾筆無條件捨去、最後一筆拿剩下的，合計一定剛好等於 shares（不會留下幽靈持股或超賣）
function spread(lots, shares) {
  const total = lots.reduce((n, l) => n + Number(l.quantity), 0)
  if (!(total > 0)) return []
  let left = shares
  return lots.map((l, i) => {
    const n = i === lots.length - 1 ? left : Math.floor((Number(l.quantity) * shares) / total)
    left -= n
    return { ...l, shares: n }
  })
}

// positions、profitLoss 用 unit=Share 查（數量是股數）；details 以 position / profit_loss 的 id 為 key
export function toRows({ positions = [], positionDetails = {}, profitLoss = [], profitDetails = {} }) {
  const rows = [], warnings = []
  const shareCount = n => (Number.isInteger(Number(n)) && Number(n) > 0 ? Number(n) : null) // 股數一定是正整數
  for (const p of positions.filter(p => isCash(p) && name(p.direction) === 'Buy')) {
    if (!shareCount(p.quantity)) {
      warnings.push(`${p.code} 的持股數看不懂（${p.quantity}），略過`) // 不要讓持股默默消失
      continue
    }
    const lots = spread(positionDetails[p.id] ?? [], Number(p.quantity))
    if (!lots.length) warnings.push(`${p.code} 查不到買進日期，略過`)
    // 明細的價格單位不一致（有的是每張），一律用持倉的平均成本（每股）
    for (const l of lots) {
      if (!isDate(day(l.date))) warnings.push(`${p.code} 有一筆持倉明細沒有日期，略過`) // 一筆壞資料不要擋住整次同步
      else rows.push({ date: day(l.date), symbol: p.code, action: 'buy', shares: l.shares, amount: Math.round(Number(p.price) * l.shares), fee: 0 })
    }
  }
  for (const pl of profitLoss.filter(isCash)) {
    const shares = shareCount(pl.quantity)
    if (!shares) {
      warnings.push(`${pl.code} ${day(pl.date)} 的賣出股數看不懂（${pl.quantity}），略過`)
      continue
    }
    const lots = spread(profitDetails[pl.id] ?? [], shares)
    // 對不到買進的賣出不寫：只有賣出會把平均成本扣掉，本金就算錯了
    if (!lots.length || ![pl, ...lots].every(x => isDate(day(x.date)))) {
      warnings.push(`${pl.code} ${day(pl.date)} 的賣出查不到買進明細或日期，略過`)
      continue
    }
    rows.push({ date: day(pl.date), symbol: pl.code, action: 'sell', shares, amount: Math.round(Number(pl.price) * shares), fee: 0 })
    for (const l of lots) {
      rows.push({ date: day(l.date), symbol: pl.code, action: 'buy', shares: l.shares, amount: Math.round(Number(l.price) * l.shares), fee: Number(l.fee) || 0 })
    }
  }
  return { rows: rows.filter(r => r.shares > 0).sort((a, b) => a.date.localeCompare(b.date)), warnings }
}
