// Public market data: the TAIEX and TWSE/TPEx closing prices, and for US holdings the Nasdaq tables and TAIFEX's USD/NTD rate.
// Always download the whole public table and match holdings locally, so which stocks the user holds never leaves this computer.
// The one exception is opt-in (pet settings → usHistory): each US symbol bought by amount only (recurring plans) gets its
// daily closes downloaded on its own, which tells Nasdaq the symbol (never amounts or who is asking).
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { addDays } from '../engine/index.js'
import { parseHistory, parseMarket, parseUs } from '../sync/market.js'

const CACHE = join(app.getPath('userData'), 'market.json')
const MAX_AGE = 6 * 3_600_000 // Closing prices change once a day, so refreshing every 6 hours is enough
const URLS = {
  index: 'https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX',
  twse: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  tpex: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
  stocks: 'https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true',
  etfs: 'https://api.nasdaq.com/api/screener/etf?download=true',
  fx: 'https://openapi.taifex.com.tw/v1/DailyForeignExchangeRates',
}
const isTw = symbol => /^\d/.test(symbol) // Taiwan codes start with a digit; US tickers never do
let market = null
let wants, onUpdate, updating = null

export const getMarket = () => market

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`${url} 回應 ${res.status}`)
  return res.json()
}

// What the holdings need: the US tables if any symbol is a US ticker, and with usHistory on, each US symbol bought by
// amount only with the earliest such buy (its history has to reach back that far)
async function needs() {
  const { records, usHistory } = await wants()
  const history = {}
  for (const r of records) {
    if (usHistory && !isTw(r.symbol) && r.action === 'buy' && !r.shares && !(history[r.symbol] <= r.date)) history[r.symbol] = r.date
  }
  return { symbols: new Set(records.map(r => r.symbol)), us: records.some(r => !isTw(r.symbol)), history }
}

// A fresh cache still needs a download when the holdings now want something it lacks (a first US ticker, a new plan)
const covers = (m, need) =>
  (!need.us || m.us) && Object.entries(need.history).every(([symbol, from]) => m.history?.[symbol]?.from <= from)

// ponytail: one request per symbol, one after another; fine for the handful of symbols a person buys every month
async function fetchHistory(need, us) {
  const history = {}
  for (const [symbol, earliest] of Object.entries(need)) {
    if (!us.prices[symbol]) { // Not a listed ticker (a typo, or delisted): nothing to look up
      history[symbol] = { from: earliest, closes: [] }
      continue
    }
    const from = addDays(earliest, -7) // A debit day on a holiday is priced at the next close, so start a little earlier
    const kind = us.etfs.includes(symbol) ? 'etf' : 'stocks'
    // The quote pages write class shares with a dot (BRK.B), unlike the screener tables
    const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical?assetclass=${kind}&fromdate=${from}&todate=${addDays(new Date().toISOString().slice(0, 10), 1)}&limit=9999`
    // One symbol failing leaves only that symbol out of the fur until the next refresh, instead of failing the whole update
    const closes = await getJson(url).then(parseHistory).catch(e => {
      console.error(`${symbol} 歷史價格下載失敗：`, e.message)
      return []
    })
    history[symbol] = { from: earliest, closes }
  }
  return history
}

async function update() {
  try {
    const need = await needs()
    if (market && Date.now() - market.fetchedAt < MAX_AGE && covers(market, need)) return
    const [index, twse] = await Promise.all([getJson(URLS.index), getJson(URLS.twse)])
    const listed = new Set(twse.map(r => r.Code))
    // The TPEx table is over 4 MB; only download it when holdings include Taiwan codes not listed on TWSE (for example, bond ETFs)
    const tpex = [...need.symbols].some(s => isTw(s) && !listed.has(s)) ? await getJson(URLS.tpex) : []
    const next = { ...parseMarket(index, twse, tpex), fetchedAt: Date.now() }
    if (need.us) {
      const [stocks, etfs, fx] = await Promise.all([getJson(URLS.stocks), getJson(URLS.etfs), getJson(URLS.fx)])
      // Which tickers are ETFs: the history lookup has to say so
      next.us = { ...parseUs(stocks.data.rows, etfs.data, fx), etfs: etfs.data.data.rows.map(r => r.symbol) }
      if (Object.keys(need.history).length) next.history = await fetchHistory(need.history, next.us)
    }
    market = next
    await writeFile(`${CACHE}.tmp`, JSON.stringify(market))
    await rename(`${CACHE}.tmp`, CACHE)
    onUpdate()
  } catch (e) {
    console.error('行情更新失敗，沿用上次的資料：', e.message) // Offline, the weather stays at the last known state
  }
}

// Called after the ledger, plans or settings change, so a new US ticker or turning on usHistory doesn't wait for the
// next hourly check; overlapping calls share one download
export function updateMarket() {
  updating ??= update().finally(() => { updating = null })
  return updating
}

// wants: async () => ({ records, usHistory }); onUpdate: called after new data is saved
export async function startMarket(options) {
  ({ wants, onUpdate } = options)
  try {
    if (existsSync(CACHE)) market = JSON.parse(await readFile(CACHE, 'utf8'))
  } catch {
    market = null // Refetch if the cache is corrupt
  }
  updateMarket()
  setInterval(updateMarket, 3_600_000)
}
