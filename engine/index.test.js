import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HEADER, parseLedger, mergeLedger, removeRows, toCsv, evaluate } from './index.js'

const buy = (date, amount, shares = 100, symbol = '0050') => ({ date, symbol, action: 'buy', shares, amount, fee: 0 })

test('parse: Excel 的 BOM 與 Windows 換行、來回轉換不變', () => {
  const rows = parseLedger(`﻿${HEADER}\r\n2026-01-06,0050,buy,160,9600,20\r\n\r\n2026-07-20,0050,dividend,0,1200,0\r\n`)
  assert.equal(rows.length, 2)
  assert.deepEqual(rows[0], { date: '2026-01-06', symbol: '0050', action: 'buy', shares: 160, amount: 9600, fee: 20 })
  assert.deepEqual(parseLedger(toCsv(rows)), rows)
})

test('parse: 壞資料要報出行號，不默默吞掉', () => {
  for (const bad of ['2026/1/6,0050,buy,1,1,0', '2026-02-30,0050,buy,1,1,0', '2026-01-06,0050,hold,1,1,0',
    '2026-01-06,0050,buy,-1,1,0', '2026-01-06,0050,buy,1,1', '2026-01-06,,buy,1,1,0', '2026-01-06,0050,buy,x,1,0']) {
    assert.throws(() => parseLedger(`${HEADER}\n${bad}`), /第 2 行/, bad)
  }
  assert.throws(() => parseLedger('日期,代號\n'), /第 1 行/)
})

test('evaluate: 同一天買進又賣出（當沖），賣出列在前面也不會留下幽靈持股', () => {
  const sell = { date: '2026-01-05', symbol: '0050', action: 'sell', shares: 1000, amount: 51000, fee: 0 }
  const dayTrade = [sell, buy('2026-01-05', 50_000, 1000)]
  assert.equal(evaluate(dayTrade, '2026-03-01').size, 1) // 本金 0；賣出被略過時會是 50,000 → Lv2
  assert.deepEqual(mergeLedger([], dayTrade).map(r => r.action), ['buy', 'sell'])
})

test('merge: 重複匯入不加資料，同日相同的兩筆都保留', () => {
  const a = [buy('2026-01-06', 9600)]
  assert.equal(mergeLedger(a, a).length, 1)
  const merged = mergeLedger(a, [buy('2026-01-06', 9600), buy('2026-01-06', 9600), buy('2026-01-01', 1)])
  assert.deepEqual(merged.map(r => r.date), ['2026-01-01', '2026-01-06', '2026-01-06'])
})

test('removeRows: 只拿掉上次同步的那幾筆，同日相同的另一筆與手動記帳都保留', () => {
  const manual = buy('2026-01-02', 500)
  const ledger = [buy('2026-01-06', 9600), buy('2026-01-06', 9600), manual]
  assert.deepEqual(removeRows(ledger, [buy('2026-01-06', 9600), buy('2026-03-01', 1)]), [buy('2026-01-06', 9600), manual])
})

test('evaluate: 沒有買入 → 還沒有蛋', () => {
  assert.equal(evaluate([], '2026-10-03').stage, 'none')
})

test('evaluate: 成長階段只看時間', () => {
  const l = [buy('2026-01-01', 1000)]
  assert.equal(evaluate(l, '2026-01-07').stage, 'egg')
  assert.equal(evaluate(l, '2026-01-08').stage, 'baby')
  assert.equal(evaluate(l, '2027-01-01').stage, 'adult')
  assert.equal(evaluate(l, '2027-01-01').age, 365)
  assert.equal(evaluate(l, '2025-12-31').stage, 'none') // 回放：未來的紀錄不算
})

test('evaluate: 體型看本金（平均成本），不看賣價', () => {
  const l = [buy('2026-01-01', 100_000)]
  assert.equal(evaluate(l, '2026-02-01').size, 3)
  // 賣一半，不管賣多少錢，本金剩 50,000
  const sell = { date: '2026-01-15', symbol: '0050', action: 'sell', shares: 50, amount: 999_999, fee: 0 }
  assert.equal(evaluate([...l, sell], '2026-02-01').size, 2)
  assert.equal(evaluate([buy('2026-01-01', 1_000_000)], '2026-02-01').size, 5)
})

test('evaluate: 飽足 — 寬限 7 天後每漏一期少一碗，最低 0', () => {
  const l = [buy('2026-01-01', 1000)]
  assert.equal(evaluate(l, '2026-02-07').satiety, 3) // 37 天：還在寬限內
  assert.equal(evaluate(l, '2026-02-08').satiety, 2) // 38 天：漏一期
  assert.equal(evaluate(l, '2027-01-01').satiety, 0)
})

test('market: 天氣看加權指數，心情看持股單日漲跌，毛色看市值對成本', () => {
  const l = [buy('2026-01-01', 10_000, 100)] // 成本每股 100
  const m = (indexChange, close, change) => ({ date: '2026-10-02', indexChange, prices: { '0050': { close, change } } })
  const at = market => evaluate(l, '2026-10-03', market)
  assert.deepEqual([at(m(0.3, 100, 0)).weather, at(m(-0.5, 100, 0)).weather, at(m(-3, 100, 0)).weather], ['sunny', 'rain', 'typhoon'])
  assert.equal(at(m(0, 101, 1.5)).mood, 'happy') // 前一天 99.5 → 101，+1.5%
  assert.equal(at(m(0, 99, -1.2)).mood, 'sad')
  assert.equal(at(m(0, 100, 0.3)).mood, 'calm')
  assert.equal(at(m(0, 106, 0)).fur, 'shiny')
  assert.equal(at(m(0, 94, 0)).fur, 'dull')
  assert.equal(at(m(0, 103, 0)).fur, 'normal')
})

test('market: 漲跌不影響成長與健康；沒行情或查不到價格時是中性', () => {
  const l = [buy('2026-01-01', 10_000, 100)]
  const crash = { date: '2026-10-02', indexChange: -8, prices: { '0050': { close: 50, change: -10 } } }
  const growth = ({ stage, age, size, satiety }) => ({ stage, age, size, satiety })
  const crashed = evaluate(l, '2026-10-03', crash)
  assert.deepEqual(growth(crashed), growth(evaluate(l, '2026-10-03')))
  assert.deepEqual([crashed.weather, crashed.mood, crashed.fur], ['typhoon', 'sad', 'dull'])
  assert.equal(evaluate(l, '2026-10-03').weather, null)
  const unknown = evaluate(l, '2026-10-03', { ...crash, prices: {} })
  assert.deepEqual([unknown.weather, unknown.mood, unknown.fur], ['typhoon', null, null])
  assert.equal(evaluate([], '2026-10-03', crash).weather, 'typhoon') // 還沒有蛋也有天氣
})
