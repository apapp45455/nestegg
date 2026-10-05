import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate } from '../engine/index.js'
import { toRows } from './sinopac.js'

// Fields and values follow the sample output in the Shioaji docs (positions and profit_loss queried with unit=Share)
const positions = [
  { id: 0, code: '2890', direction: 'Buy', quantity: 1000, price: 30.0, last_price: 31.0, cond: 'Cash' },
  { id: 1, code: '2330', direction: 'Buy', quantity: 1000, price: 2000.0, cond: 'MarginTrading' },
  { id: 2, code: '2603', direction: 'Sell', quantity: 1000, price: 150.0, cond: 'ShortSelling' },
]
const positionDetails = {
  0: [{ date: '2026-05-18', code: '2890', quantity: 1, price: 30000, dseq: 'Y1QDH', cond: 'Cash' }], // Details in board lots, prices per board lot
}
const profitLoss = [{ id: 0, code: '2890', quantity: 1000, price: 31, date: '2026-05-05', pnl: 1000, cond: 'StockOrderCond.Cash' }]
const profitDetails = {
  0: [{ date: '2026-04-23', code: '2890', quantity: 1, price: 30.0, fee: 119, cost: 30119, trade_type: 'Common', cond: 'Cash' }],
}

test('sinopac: 持倉與已實現損益拼回買賣紀錄，只算現股', () => {
  const { rows, warnings } = toRows({ positions, positionDetails, profitLoss, profitDetails })
  assert.deepEqual(rows, [
    { date: '2026-04-23', symbol: '2890', action: 'buy', shares: 1000, amount: 30000, fee: 119 },
    { date: '2026-05-05', symbol: '2890', action: 'sell', shares: 1000, amount: 31000, fee: 0 },
    { date: '2026-05-18', symbol: '2890', action: 'buy', shares: 1000, amount: 30000, fee: 0 },
  ])
  assert.deepEqual(warnings, [])
})

test('sinopac: 同一檔分幾次買，依明細的比例分股數；查不到明細的提醒並略過', () => {
  const { rows, warnings } = toRows({
    positions: [{ id: 5, code: '0050', direction: 'Buy', quantity: 1500, price: 150, cond: 'Cash' }, { id: 6, code: '00878', direction: 'Buy', quantity: 1000, price: 21, cond: 'Cash' }],
    positionDetails: { 5: [{ date: '20260102', quantity: 1000 }, { date: '2026/02/03', quantity: 500 }] },
  })
  assert.deepEqual(rows.map(r => [r.date, r.shares, r.amount]), [['2026-01-02', 1000, 150000], ['2026-02-03', 500, 75000]])
  assert.deepEqual(warnings, ['00878 查不到買進日期，略過'])
  assert.deepEqual(toRows({ positions: [{ id: 6, code: '00878', direction: 'Buy', quantity: 1000, price: 21, cond: 'Cash' }] }).skipped, ['00878'])
})

test('sinopac: 分成三筆時股數合計不會少（33+33+34），賣出查不到買進明細的提醒並略過', () => {
  const { rows, warnings } = toRows({
    profitLoss: [
      { id: 0, code: '2890', quantity: 100, price: 31, date: '2026-05-05', cond: 'Cash' },
      { id: 1, code: '2330', quantity: 1000, price: 1980, date: '2026-05-06', cond: 'Cash' },
    ],
    profitDetails: { 0: [1, 2, 3].map(d => ({ date: `2026-04-0${d}`, quantity: 1, price: 30, fee: 0 })) },
  })
  assert.deepEqual(rows.filter(r => r.action === 'buy').map(r => r.shares), [33, 33, 34])
  assert.equal(rows.filter(r => r.symbol === '2330').length, 0)
  assert.deepEqual(warnings, ['2330 2026-05-06 的賣出查不到買進明細或日期，略過'])
})

test('sinopac: 當沖（同一天買進又賣出）不會留下幽靈持股', () => {
  const { rows } = toRows({
    profitLoss: [{ id: 0, code: '2330', quantity: 100, price: 510, date: '2026-05-06', cond: 'Cash' }],
    profitDetails: { 0: [{ date: '2026-05-06', quantity: 100, price: 500, fee: 0, trade_type: 'DayTrade', cond: 'Cash' }] },
  })
  assert.equal(evaluate(rows, '2026-06-01').size, 1) // Principal 0; if the sell were skipped it would be 50,000 → Lv2
})

test('sinopac: 沒有日期的明細提醒並略過，不會擋住其他紀錄', () => {
  const { rows, warnings } = toRows({
    positions: [{ id: 0, code: '0050', direction: 'Buy', quantity: 2000, price: 150, cond: 'Cash' }],
    positionDetails: { 0: [{ date: '2026-01-02', quantity: 1 }, { quantity: 1 }] },
    profitLoss: [{ id: 1, code: '2330', quantity: 100, price: 510, cond: 'Cash' }],
    profitDetails: { 1: [{ date: '2026-05-01', quantity: 100, price: 500 }] },
  })
  assert.deepEqual(rows.map(r => [r.date, r.symbol, r.shares]), [['2026-01-02', '0050', 1000]])
  assert.equal(warnings.length, 2)
})

test('sinopac: 股數看不懂（NaN、小數、0）的提醒並略過，不會默默消失', () => {
  const { rows, warnings } = toRows({
    positions: [{ id: 0, code: '0050', direction: 'Buy', quantity: 'abc', price: 150, cond: 'Cash' }],
    positionDetails: { 0: [{ date: '2026-01-02', quantity: 1 }] },
    profitLoss: [{ id: 1, code: '2330', quantity: 1.5, price: 510, date: '2026-05-06', cond: 'Cash' }, { id: 2, code: '2317', quantity: 0, price: 100, date: '2026-05-07', cond: 'Cash' }],
    profitDetails: { 1: [{ date: '2026-05-01', quantity: 1, price: 500 }], 2: [{ date: '2026-05-01', quantity: 1, price: 90 }] },
  })
  assert.deepEqual(rows, [])
  assert.equal(warnings.length, 3)
})

test('sinopac: 沒有任何資料時是空的', () => {
  assert.deepEqual(toRows({}), { rows: [], warnings: [], skipped: [] })
})
