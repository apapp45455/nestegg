import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HEADER, parseLedger, parsePlans, parseSettings, mergeLedger, planRows, removeRows, toCsv, evaluate } from './index.js'

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
  assert.equal(evaluate(dayTrade, '2026-03-01').size, 1) // Principal 0; if the sell were skipped it would be 50,000 → Lv2
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
  assert.equal(evaluate(l, '2025-12-31').stage, 'none') // Replay: future records don't count
})

test('evaluate: 體型看本金（平均成本），不看賣價', () => {
  const l = [buy('2026-01-01', 100_000)]
  assert.equal(evaluate(l, '2026-02-01').size, 3)
  // Sell half: whatever the price, 50,000 of principal remains
  const sell = { date: '2026-01-15', symbol: '0050', action: 'sell', shares: 50, amount: 999_999, fee: 0 }
  assert.equal(evaluate([...l, sell], '2026-02-01').size, 2)
  assert.equal(evaluate([buy('2026-01-01', 1_000_000)], '2026-02-01').size, 5)
})

test('evaluate: 飽足 — 寬限 7 天後每漏一期少一碗，最低 0', () => {
  const l = [buy('2026-01-01', 1000)]
  assert.equal(evaluate(l, '2026-02-07').satiety, 3) // 37 days: still within the grace period
  assert.equal(evaluate(l, '2026-02-08').satiety, 2) // 38 days: one period missed
  assert.equal(evaluate(l, '2027-01-01').satiety, 0)
})

test('market: 天氣看加權指數，心情看持股單日漲跌，毛色看市值對成本', () => {
  const l = [buy('2026-01-01', 10_000, 100)] // Cost of 100 per share
  const m = (indexChange, close, change) => ({ date: '2026-10-02', indexChange, prices: { '0050': { close, change } } })
  const at = market => evaluate(l, '2026-10-03', market)
  assert.deepEqual([at(m(0.3, 100, 0)).weather, at(m(-0.5, 100, 0)).weather, at(m(-3, 100, 0)).weather], ['sunny', 'rain', 'typhoon'])
  assert.equal(at(m(0, 101, 1.5)).mood, 'happy') // Previous day 99.5 → 101, +1.5%
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
  assert.equal(evaluate([], '2026-10-03', crash).weather, 'typhoon') // Weather shows even before there's an egg
})

test('settings: 週投的人照週算飽足；敏感度調高後小漲跌不影響心情', () => {
  const l = [buy('2026-01-01', 10_000, 100)]
  assert.equal(evaluate(l, '2026-01-20').satiety, 3) // Default monthly period: still full after 19 days
  assert.equal(evaluate(l, '2026-01-20', null, { period: 7, grace: 2 }).satiety, 1) // Weekly with 2 grace days: two periods missed
  const m = { date: '2026-01-19', indexChange: -2, prices: { '0050': { close: 101.5, change: 1.5 } } } // +1.5% on the day
  assert.deepEqual(['weather', 'mood'].map(k => evaluate(l, '2026-01-20', m)[k]), ['rain', 'happy'])
  assert.deepEqual(['weather', 'mood'].map(k => evaluate(l, '2026-01-20', m, { typhoon: 1.5, mood: 2 })[k]), ['typhoon', 'calm'])
  assert.equal(evaluate(l, '2026-01-20', m, { fur: 1 }).fur, 'shiny') // Cost 100 → 101.5, +1.5%
})

test('settings: 手改壞的設定（字串、超出範圍、天數有小數）每一項各自回到預設', () => {
  const defaults = parseSettings()
  assert.deepEqual(defaults, { period: 31, grace: 7, typhoon: 3, mood: 1, fur: 5, lv2: 3, lv3: 10, lv4: 30, lv5: 100 })
  assert.deepEqual(parseSettings({ period: '7', grace: -1, typhoon: 99, mood: 2, fur: null }), { ...defaults, mood: 2 })
  assert.equal(parseSettings({ period: 7.5 }).period, 31)
  assert.equal(parseSettings({ mood: 0.5 }).mood, 0.5) // Percentages can have decimals
  assert.deepEqual(parseSettings('壞掉的檔案'), defaults)
})

test('settings: 體型門檻可以調（萬元）；沒有一級比一級高就四個一起回到預設', () => {
  const l = [buy('2026-01-01', 50_000)]
  assert.equal(evaluate(l, '2026-02-01').size, 2) // Defaults: NT$30,000 for Lv2, NT$100,000 for Lv3
  assert.equal(evaluate(l, '2026-02-01', null, { lv2: 1, lv3: 2, lv4: 4, lv5: 5 }).size, 5)
  assert.equal(evaluate(l, '2026-02-01', null, { lv2: 10, lv3: 20, lv4: 40, lv5: 80 }).size, 1)
  assert.equal(evaluate([buy('2026-01-01', 1_400)], '2026-02-01', null, { lv2: 0.14 }).size, 2) // Levels up at exactly 0.14 (0.14 × 10,000 has a floating-point error)
  const broken = parseSettings({ lv2: 50, mood: 2 }) // Lv2 higher than Lv3 (default 10)
  assert.deepEqual([broken.lv2, broken.lv3, broken.mood], [3, 10, 2]) // Other settings are unaffected
})

test('planRows: one buy a month on the plan day, from the start date to today or the end date', () => {
  const vt = { symbol: 'VOO', amount: 10_000, day: 6, start: '2026-01-10', end: null }
  // Starts after the 6th in January, so the first month is February
  assert.deepEqual(planRows([vt], '2026-04-05').map(r => r.date), ['2026-02-06', '2026-03-06'])
  assert.deepEqual(planRows([vt], '2026-04-06').at(-1), { date: '2026-04-06', symbol: 'VOO', action: 'buy', shares: 0, amount: 10_000, fee: 0 })
  assert.deepEqual(planRows([{ ...vt, end: '2026-03-31' }], '2026-12-31').map(r => r.date), ['2026-02-06', '2026-03-06'])
  // Day 31 falls on the last day of shorter months, across a year end
  const late = { ...vt, day: 31, start: '2025-11-01' }
  assert.deepEqual(planRows([late], '2026-03-01').map(r => r.date), ['2025-11-30', '2025-12-31', '2026-01-31', '2026-02-28'])
  assert.deepEqual(planRows([vt], '2025-12-31'), []) // Not started yet
  assert.deepEqual(parseLedger(toCsv(planRows([vt], '2026-04-06'))), planRows([vt], '2026-04-06'))
})

test('planRows: the pet counts plan contributions like any other buy', () => {
  const plan = { symbol: 'VOO', amount: 10_000, day: 6, start: '2025-01-01', end: null }
  const pet = evaluate(planRows([plan], '2026-01-10'), '2026-01-10')
  assert.deepEqual([pet.stage, pet.size, pet.satiety], ['adult', 3, 3]) // 13 months × 10,000 = 130,000
})

test('parsePlans: normalizes good plans and names the problem in a bad one', () => {
  assert.deepEqual(parsePlans([{ symbol: ' voo ', amount: '10000', day: '6', start: '2026-01-06', end: '' }]), [
    { symbol: 'VOO', amount: 10_000, day: 6, start: '2026-01-06', end: null },
  ])
  const good = { symbol: '0050', amount: 5000, day: 16, start: '2026-01-16' }
  assert.throws(() => parsePlans([good, { ...good, amount: 0 }]), /第 2 個計畫：每月金額/)
  assert.throws(() => parsePlans([{ ...good, day: 32 }]), /扣款日/)
  assert.throws(() => parsePlans([{ ...good, symbol: '' }]), /標的代號/)
  assert.throws(() => parsePlans([{ ...good, end: '2025-12-31' }]), /結束日期/)
  assert.throws(() => parsePlans({}), /格式不對/)
})
