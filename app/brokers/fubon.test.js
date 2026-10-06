// When auto sync refuses to turn missing holdings into sells. The worker is replaced by a function returning its reply
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fubon from './fubon.js'

const previous = [
  { date: '2026-01-06', symbol: '0050', action: 'buy', shares: 100, amount: 7_000, fee: 0 },
  { date: '2026-01-06', symbol: '2330', action: 'buy', shares: 10, amount: 10_000, fee: 0 },
]
const held2330 = { stockNo: '2330', orderType: 'Stock', todayQty: 10, costPrice: 1_000 }
const sync = (reply, manual = false) =>
  fubon.fetch({ creds: {}, to: '2026-10-06', previous, manual, runWorker: async () => ({ accounts: 2, assets: [], errors: [], noData: 0, ...reply }) })

test('fubon: auto sync pauses instead of selling when an account answers 查無 or nothing comes back', async () => {
  // One account answers 查無 and its 0050 is missing from the holdings
  await assert.rejects(sync({ assets: [held2330], noData: 1 }), e => e.needsUser && /立即同步/.test(e.message))
  await assert.rejects(sync({ assets: [] }), e => e.needsUser)
  // The user confirms with a manual sync: the missing 0050 is recorded as sold
  const { rows } = await sync({ assets: [held2330], noData: 1 }, true)
  assert.deepEqual(rows.slice(2).map(r => [r.symbol, r.action, r.shares]), [['0050', 'sell', 100]])
  // 查無 for an account that held nothing recorded changes nothing, and a real partial sell still goes through
  assert.equal((await sync({ assets: [held2330, { ...held2330, stockNo: '0050', todayQty: 100, costPrice: 70 }], noData: 1 })).rows.length, 2)
  const sold = await sync({ assets: [held2330, { ...held2330, stockNo: '0050', todayQty: 40, costPrice: 70 }] })
  assert.deepEqual(sold.rows.slice(2).map(r => [r.symbol, r.action, r.shares]), [['0050', 'sell', 60]])
})
