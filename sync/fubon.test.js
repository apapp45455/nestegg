import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dateWindows, fillsToRows, positionsOf, reconcile } from './fubon.js'
import { evaluate, parseLedger, toCsv } from '../engine/index.js'

test('dateWindows: 每段最多 30 天、首尾相接、不超過結束日', () => {
  assert.deepEqual(dateWindows('2026-01-01', '2026-01-01'), [['20260101', '20260101']])
  assert.deepEqual(dateWindows('2026-01-01', '2026-03-05'), [
    ['20260101', '20260130'], ['20260131', '20260301'], ['20260302', '20260305'],
  ])
  assert.deepEqual(dateWindows('2026-02-01', '2026-01-01'), [])
})

test('fillsToRows: 現股與當沖轉成帳本列，其他略過，結果能通過帳本驗證', () => {
  const fill = { date: '2026/09/15', stockNo: '0050', buySell: 'Buy', orderType: 'Stock', filledQty: 1000, filledPrice: 35.25 }
  const rows = fillsToRows([
    fill,
    { ...fill, date: '20260916', buySell: 'Sell', orderType: 'DayTrade', filledQty: 3 },
    { ...fill, orderType: 'Margin' },
    { ...fill, buySell: 'UnDefined' },
  ])
  assert.deepEqual(rows, [
    { date: '2026-09-15', symbol: '0050', action: 'buy', shares: 1000, amount: 35250, fee: 0 },
    { date: '2026-09-16', symbol: '0050', action: 'sell', shares: 3, amount: 106, fee: 0 },
  ])
  assert.deepEqual(parseLedger(toCsv(rows)), rows)
})

test('positionsOf: only cash holdings, summed across accounts; unreadable numbers stop the sync', () => {
  const asset = { stockNo: '0050', orderType: 'Stock', todayQty: 1000, costPrice: 100 }
  assert.deepEqual(positionsOf([asset, { ...asset, todayQty: 500, costPrice: 130 }, { ...asset, orderType: 'Margin' }]), {
    '0050': { shares: 1500, cost: 165_000 },
  })
  assert.throws(() => positionsOf([{ ...asset, todayQty: 1.5 }]), /看不懂/)
  assert.throws(() => positionsOf([{ ...asset, costPrice: undefined }]), /看不懂/)
})

test('reconcile: more shares become a buy today, fewer a sell; nothing changes when the holdings match', () => {
  const owned = [{ date: '2026-09-07', symbol: '0050', action: 'buy', shares: 1000, amount: 100_000, fee: 0 }]
  assert.deepEqual(reconcile({ '0050': { shares: 1000, cost: 100_000 } }, owned, '2026-10-06'), [])
  // Bought 200 more for 21,000
  assert.deepEqual(reconcile({ '0050': { shares: 1200, cost: 121_000 } }, owned, '2026-10-06'), [
    { date: '2026-10-06', symbol: '0050', action: 'buy', shares: 200, amount: 21_000, fee: 0 },
  ])
  // Sold 400 (at the recorded average cost of 100), and sold 2330 completely
  const both = [...owned, { date: '2026-09-07', symbol: '2330', action: 'buy', shares: 10, amount: 9_000, fee: 0 }]
  assert.deepEqual(reconcile({ '0050': { shares: 600, cost: 60_000 } }, both, '2026-10-06'), [
    { date: '2026-10-06', symbol: '0050', action: 'sell', shares: 400, amount: 40_000, fee: 0 },
    { date: '2026-10-06', symbol: '2330', action: 'sell', shares: 10, amount: 9_000, fee: 0 },
  ])
})

test('reconcile: without history, current holdings are recorded as bought today, so the pet starts as an egg', () => {
  const rows = reconcile({ '0050': { shares: 1000, cost: 98_765.4 } }, [], '2026-10-06')
  assert.deepEqual(rows, [{ date: '2026-10-06', symbol: '0050', action: 'buy', shares: 1000, amount: 98_765, fee: 0 }])
  assert.deepEqual(parseLedger(toCsv(rows)), rows)
  const pet = evaluate(rows, '2026-10-06')
  assert.deepEqual([pet.stage, pet.size], ['egg', 2])
})
