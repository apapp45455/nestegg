// Public market data: the TAIEX (weather) and TWSE/TPEx closing prices (mood, fur).
// Always download the whole public table and match holdings locally, so which stocks the user holds never leaves this computer.
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseMarket } from '../sync/market.js'

const CACHE = join(app.getPath('userData'), 'market.json')
const MAX_AGE = 6 * 3_600_000 // Closing prices change once a day, so refreshing every 6 hours is enough
const URLS = {
  index: 'https://openapi.twse.com.tw/v1/exchangeReport/MI_INDEX',
  twse: 'https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL',
  tpex: 'https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes',
}
let market = null

export const getMarket = () => market

async function getJson(url) {
  const res = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`${url} 回應 ${res.status}`)
  return res.json()
}

async function update(symbols, onUpdate) {
  if (market && Date.now() - market.fetchedAt < MAX_AGE) return
  try {
    const [index, twse] = await Promise.all([getJson(URLS.index), getJson(URLS.twse)])
    const listed = new Set(twse.map(r => r.Code))
    // The TPEx table is over 4 MB; only download it when holdings include Taiwan codes not listed on TWSE (for example,
    // bond ETFs). Taiwan codes start with a digit; US tickers such as VOO never appear in either table
    const tpex = (await symbols()).some(s => /^\d/.test(s) && !listed.has(s)) ? await getJson(URLS.tpex) : []
    market = { ...parseMarket(index, twse, tpex), fetchedAt: Date.now() }
    await writeFile(`${CACHE}.tmp`, JSON.stringify(market))
    await rename(`${CACHE}.tmp`, CACHE)
    onUpdate()
  } catch (e) {
    console.error('行情更新失敗，沿用上次的資料：', e.message) // Offline, the weather stays at the last known state
  }
}

export async function startMarket({ symbols, onUpdate }) {
  try {
    if (existsSync(CACHE)) market = JSON.parse(await readFile(CACHE, 'utf8'))
  } catch {
    market = null // Refetch if the cache is corrupt
  }
  update(symbols, onUpdate)
  setInterval(() => update(symbols, onUpdate), 3_600_000)
}
