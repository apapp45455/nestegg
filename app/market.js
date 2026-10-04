// 公開行情：加權指數（天氣）與上市、上櫃收盤價（心情、毛色）。
// 一律下載整張公開表格、在本機比對持股 —— 你持有哪些股票不會送出這台電腦。
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseMarket } from '../sync/market.js'

const CACHE = join(app.getPath('userData'), 'market.json')
const MAX_AGE = 6 * 3_600_000 // 收盤價一天只變一次，6 小時更新一次就夠
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
    // 上櫃表格有 4 MB 多，持股裡有上市找不到的代號（例如債券 ETF）才下載
    const tpex = (await symbols()).some(s => !listed.has(s)) ? await getJson(URLS.tpex) : []
    market = { ...parseMarket(index, twse, tpex), fetchedAt: Date.now() }
    await writeFile(`${CACHE}.tmp`, JSON.stringify(market))
    await rename(`${CACHE}.tmp`, CACHE)
    onUpdate()
  } catch (e) {
    console.error('行情更新失敗，沿用上次的資料：', e.message) // 離線時天氣停在上一次
  }
}

export async function startMarket({ symbols, onUpdate }) {
  try {
    if (existsSync(CACHE)) market = JSON.parse(await readFile(CACHE, 'utf8'))
  } catch {
    market = null // 快取壞了就重抓
  }
  update(symbols, onUpdate)
  setInterval(() => update(symbols, onUpdate), 3_600_000)
}
