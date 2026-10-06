import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseHistory, parseMarket, parseUs } from './market.js'

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

// Fields and formats copied from the real Nasdaq and TAIFEX responses of 2026-10-06
const stocks = [
  { symbol: 'BRK/B', lastsale: '$502.65', netchange: '2.15', pctchange: '0.43%' },
  { symbol: 'ZZZZ', lastsale: 'NA', netchange: 'UNCH', pctchange: '' },
]
const etfs = { dataAsOf: '10/2/2026 8:00:00 PM', data: { rows: [{ symbol: 'VOO', lastSalePrice: '$707.5400', netChange: '5.1900', percentageChange: '0.7335%' }] } }
const fx = [{ Date: '20261002', 'USD/NTD': '31.700' }, { Date: '20261005', 'USD/NTD': '31.788' }]

test('parseUs: stocks and ETFs in US dollars, BRK/B as BRK.B, the S&P 500 from VOO, the latest USD/NTD rate', () => {
  assert.deepEqual(parseUs(stocks, etfs, fx), {
    date: '2026-10-02',
    indexChange: 0.74, // 5.19 / 702.35
    fx: 31.788,
    prices: { 'BRK.B': { close: 502.65, change: 2.15 }, VOO: { close: 707.54, change: 5.19 } },
  })
  assert.throws(() => parseUs(stocks, { ...etfs, data: { rows: [] } }, fx), /VOO/)
  assert.throws(() => parseUs(stocks, etfs, []), /匯率/)
})

test('parseHistory: newest-first rows become oldest-first [date, close]; an unknown symbol is an empty history', () => {
  const res = { data: { tradesTable: { rows: [{ date: '10/05/2026', close: '$171.29' }, { date: '10/02/2026', close: '167.78' }] } } }
  assert.deepEqual(parseHistory(res), [['2026-10-02', 167.78], ['2026-10-05', 171.29]])
  assert.deepEqual(parseHistory({ data: null, status: { rCode: 400 } }), [])
})
