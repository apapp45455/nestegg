// Sinopac Securities Shioaji account data → NestEgg ledger rows. Pure functions; no network, no Shioaji.
//
// Shioaji has no trade history query (order_deal_records only covers today), so trades are rebuilt from two sources:
// - Still held: positions + each position's buy details (position_detail, with buy dates)
// - Already sold: realized P&L (profit_loss, on the sell date) + the matching buy details (profit_loss_detail, with buy dates and prices)
// Positions are a snapshot of now and change after a partial sale, so every sync rebuilds them and replaces the batch the last sync wrote.
import { isDate } from '../engine/index.js'

const name = v => String(v ?? '').split('.').pop() // 'Cash'; some versions output 'StockOrderCond.Cash'
const day = d => String(d).replace(/^(\d{4})[-/]?(\d{2})[-/]?(\d{2}).*$/, '$1-$2-$3') // Also accepts 20260518 and 2026/05/18
const isCash = r => name(r.cond) === 'Cash' // Margin buying and short selling don't use the user's own principal, so they don't count

// Detail quantities are sometimes in board lots and sometimes in shares; convert them back to shares using the total share count.
// Round every lot but the last down, and give the last one the remainder, so the total always equals shares exactly (no phantom shares, no overselling)
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

// positions and profitLoss are queried with unit=Share (quantities are shares); details are keyed by the position / profit_loss id
export function toRows({ positions = [], positionDetails = {}, profitLoss = [], profitDetails = {} }) {
  const rows = [], warnings = [], skipped = new Set()
  // Record stocks with incomplete data: the snapshot replacement keeps their previous batch, so temporarily missing data never removes them from the ledger
  const skip = (code, message) => { warnings.push(message); skipped.add(code) }
  const shareCount = n => (Number.isInteger(Number(n)) && Number(n) > 0 ? Number(n) : null) // A share count must be a positive integer
  for (const p of positions.filter(p => isCash(p) && name(p.direction) === 'Buy')) {
    if (!shareCount(p.quantity)) {
      skip(p.code, `${p.code} 的持股數看不懂（${p.quantity}），略過`) // Don't let a holding silently disappear
      continue
    }
    const lots = spread(positionDetails[p.id] ?? [], Number(p.quantity))
    if (!lots.length) skip(p.code, `${p.code} 查不到買進日期，略過`)
    // Detail prices use inconsistent units (some are per board lot), so always use the position's average cost per share
    for (const l of lots) {
      if (!isDate(day(l.date))) skip(p.code, `${p.code} 有一筆持倉明細沒有日期，略過`) // One bad record shouldn't block the whole sync
      else rows.push({ date: day(l.date), symbol: p.code, action: 'buy', shares: l.shares, amount: Math.round(Number(p.price) * l.shares), fee: 0 })
    }
  }
  for (const pl of profitLoss.filter(isCash)) {
    const shares = shareCount(pl.quantity)
    if (!shares) {
      skip(pl.code, `${pl.code} ${day(pl.date)} 的賣出股數看不懂（${pl.quantity}），略過`)
      continue
    }
    const lots = spread(profitDetails[pl.id] ?? [], shares)
    // Don't write sells without matching buys: a sell alone would deduct average cost and get the principal wrong
    if (!lots.length || ![pl, ...lots].every(x => isDate(day(x.date)))) {
      skip(pl.code, `${pl.code} ${day(pl.date)} 的賣出查不到買進明細或日期，略過`)
      continue
    }
    rows.push({ date: day(pl.date), symbol: pl.code, action: 'sell', shares, amount: Math.round(Number(pl.price) * shares), fee: 0 })
    for (const l of lots) {
      rows.push({ date: day(l.date), symbol: pl.code, action: 'buy', shares: l.shares, amount: Math.round(Number(l.price) * l.shares), fee: Number(l.fee) || 0 })
    }
  }
  return { rows: rows.filter(r => r.shares > 0).sort((a, b) => a.date.localeCompare(b.date)), warnings, skipped: [...skipped] }
}
