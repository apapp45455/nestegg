import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dateWindows, fillsToRows } from './fubon.js'
import { parseLedger, toCsv } from '../engine/index.js'

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
