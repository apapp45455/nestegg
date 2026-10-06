import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseLedger, toCsv } from '../engine/index.js'
import { flexWindows, parseCbcRates, parseFlexStatus, parseTrades, toRows } from './ibkr.js'

// The failure was answered by the real service on 2026-10-06 (a made-up token); the success follows IBKR's documentation
const FAIL = `<FlexStatementResponse timestamp='06 October, 2026 10:00 AM EDT'>
<Status>Fail</Status>
<ErrorCode>1015</ErrorCode>
<ErrorMessage>Token is invalid.</ErrorMessage>
</FlexStatementResponse>`
const SUCCESS = `<FlexStatementResponse timestamp='06 October, 2026 10:00 AM EDT'>
<Status>Success</Status>
<ReferenceCode>1234567890</ReferenceCode>
<Url>https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement</Url>
</FlexStatementResponse>`

const trade = attrs => `<Trade accountId="U1234567" currency="USD" assetCategory="STK" levelOfDetail="EXECUTION" ${Object.entries(attrs).map(([k, v]) => `${k}="${v}"`).join(' ')} />`
const STATEMENT = `<FlexQueryResponse queryName="NestEgg" type="AF">
<FlexStatements count="1">
<FlexStatement accountId="U1234567" fromDate="20250901" toDate="20250930" period="" whenGenerated="20251006;100000">
<Trades>
${trade({ symbol: 'VOO', description: 'VANGUARD S&amp;P 500 ETF', tradeDate: '20250915', quantity: '10', tradePrice: '500', proceeds: '-5000', ibCommission: '-1', buySell: 'BUY' })}
${trade({ symbol: 'VOO', tradeDate: '20250915', quantity: '10', tradePrice: '500', proceeds: '-5000', ibCommission: '-1', buySell: 'BUY', levelOfDetail: 'ORDER' })}
${trade({ symbol: 'BRK B', tradeDate: '2025-09-16', quantity: '2', tradePrice: '450', proceeds: '-900', ibCommission: '-1', buySell: 'BUY' })}
${trade({ symbol: 'VOO', tradeDate: '20250920', quantity: '-3', tradePrice: '520', proceeds: '1560', ibCommission: '-1', taxes: '-0.03', buySell: 'SELL' })}
${trade({ symbol: 'VOO  250919C00500000', assetCategory: 'OPT', tradeDate: '20250915', quantity: '1', proceeds: '-300', buySell: 'BUY' })}
${trade({ symbol: 'VOO', tradeDate: '20250917', quantity: '-1', proceeds: '500', buySell: 'BUY (Ca.)' })}
${trade({ symbol: '700', currency: 'HKD', tradeDate: '20250917', quantity: '100', proceeds: '-50000', buySell: 'BUY' })}
${trade({ symbol: 'QQQ', tradeDate: '20250923', quantity: '1', proceeds: '-600', buySell: 'BUY' })}
</Trades>
</FlexStatement>
</FlexStatements>
</FlexQueryResponse>`

// Shaped like the central bank's BP01D01: the first cell is the date, the next column is NT$ per US$
const CBC = {
  data: {
    structure: { Table1: [{ data: '新台幣NTD/USD' }, { data: '日圓JPY/USD' }] },
    dataSets: [['20250916', '30.300', '147.0'], ['20250912', '30.100', '147.5'], ['20250915', '30.200', '147.2'], ['20250919', '30.400', '148.0'], ['20250922', '30.500', '148.1'], ['20250918', '-', '-']],
  },
}

test('parseFlexStatus: success gives the reference code, failure the error code; a statement is not a status', () => {
  assert.deepEqual(parseFlexStatus(SUCCESS), { ok: true, referenceCode: '1234567890' })
  assert.deepEqual(parseFlexStatus(FAIL), { ok: false, code: 1015, message: 'Token is invalid.' })
  assert.equal(parseFlexStatus(STATEMENT), null)
})

test('parseTrades: every Trade with its attributes, entities decoded; a CSV report is refused', () => {
  const trades = parseTrades(STATEMENT)
  assert.equal(trades.length, 8)
  assert.equal(trades[0].description, 'VANGUARD S&P 500 ETF')
  assert.throws(() => parseTrades('ClientAccountID,Symbol\nU1,VOO'), /XML/)
})

test('parseCbcRates: NT$ per US$ by date, oldest first, gaps left out; a changed layout is an error', () => {
  assert.deepEqual(parseCbcRates(CBC), [['2025-09-12', 30.1], ['2025-09-15', 30.2], ['2025-09-16', 30.3], ['2025-09-19', 30.4], ['2025-09-22', 30.5]])
  assert.throws(() => parseCbcRates({ data: { structure: { Table1: [{ data: '日圓JPY/USD' }] }, dataSets: [] } }), /新台幣/)
})

test('toRows: US-dollar stock executions in NT$ at the rate of the trade date; the rest is left out with a reason', () => {
  const { rows, warnings } = toRows(parseTrades(STATEMENT), parseCbcRates(CBC), '2025-09-01', '2025-09-30')
  assert.deepEqual(rows, [
    { date: '2025-09-15', symbol: 'VOO', action: 'buy', shares: 10, amount: 151_000, fee: 30 }, // 5,000 × 30.2
    { date: '2025-09-16', symbol: 'BRK.B', action: 'buy', shares: 2, amount: 27_270, fee: 30 },
    { date: '2025-09-20', symbol: 'VOO', action: 'sell', shares: 3, amount: 47_424, fee: 31 }, // A Saturday: Friday's 30.4, once Monday's is out
  ])
  assert.deepEqual(parseLedger(toCsv(rows)), rows) // Valid ledger rows
  assert.equal(warnings.length, 3)
  assert.match(warnings.join('\n'), /1 筆最近的交易還等不到/) // QQQ on 09-23, after the latest published rate
  assert.match(warnings.join('\n'), /非美元的交易（HKD）/)
  assert.match(warnings.join('\n'), /1 筆已取消/)
  // Outside the requested dates: left to the sync that asks for them
  assert.deepEqual(toRows(parseTrades(STATEMENT), parseCbcRates(CBC), '2025-09-16', '2025-09-16').rows.map(r => r.symbol), ['BRK.B'])
})

test('flexWindows: 365-day ranges in yyyyMMdd covering from to to', () => {
  assert.deepEqual(flexWindows('2024-01-01', '2025-03-01'), [['20240101', '20241230'], ['20241231', '20250301']])
  assert.deepEqual(flexWindows('2026-10-06', '2026-10-06'), [['20261006', '20261006']])
})
