import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseMarket } from './market.js'

// Fields and formats copied from the real API responses of 2026-10-02
const index = [
  { 日期: '1151002', 指數: '寶島股價指數', 漲跌: '+', 漲跌百分比: '0.37' },
  { 日期: '1151002', 指數: '發行量加權股價指數', 漲跌: '-', 漲跌百分比: '1.25' },
]
const twse = [
  { Code: '0050', ClosingPrice: '112.80', Change: '-0.1000' },
  { Code: '9999', ClosingPrice: '--', Change: '' },
]
const tpex = [{ SecuritiesCompanyCode: '00679B', Close: '24.61', Change: '-0.03 ' }]

test('parseMarket: 民國日期、漲跌符號、上市上櫃合併、沒成交的略過', () => {
  assert.deepEqual(parseMarket(index, twse, tpex), {
    date: '2026-10-02',
    indexChange: -1.25,
    prices: { '00679B': { close: 24.61, change: -0.03 }, '0050': { close: 112.8, change: -0.1 } },
  })
  assert.throws(() => parseMarket([], twse), /加權指數/)
})
