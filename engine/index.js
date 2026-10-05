// 寵物引擎：純函式，沒有隱藏狀態。同一份帳本 + 同一天 + 同一份行情 = 同一隻寵物。
// 成長只看你控制的事（時間、投入）；市場漲跌只影響天氣、心情、毛色，不影響成長與健康。

export const HEADER = 'date,symbol,action,shares,amount,fee'
const ACTIONS = ['buy', 'sell', 'dividend']

// 數值表（Phase 0）：調數值只改這裡。孵化、長大只看時間，不開放使用者調整（調了養寵物就沒有意義）
export const HATCH_DAYS = 7 // 第一次買入後幾天孵化
export const ADULT_DAYS = 365 // 幾天長成成年

// 使用者在「寵物設定」可以調的（存在 settings.json）；value 是預設值
export const SETTINGS = {
  period: { value: 31, min: 7, max: 92, step: 1 }, // 投入週期（天）：每月扣款 31、每週 7、每季 92
  grace: { value: 7, min: 0, max: 30, step: 1 }, // 扣款日遇假日、同步延遲的寬限（天）
  typhoon: { value: 3, min: 0.5, max: 10, step: 0.5 }, // 加權指數單日跌幅 ≥ 幾 % → 颱風（其餘下跌 → 下雨）
  mood: { value: 1, min: 0.1, max: 10, step: 0.1 }, // 持股單日漲跌 ± 幾 % 以上 → 開心 / 難過
  fur: { value: 5, min: 0.5, max: 50, step: 0.5 }, // 持股市值相對成本 ± 幾 % 以上 → 毛色發亮 / 黯淡
  // 本金到幾萬元長大一級（Lv1 → Lv5）；每個人的資產規模差很多，所以可以調
  lv2: { value: 3, min: 0.1, max: 10_000, step: 0.1 },
  lv3: { value: 10, min: 0.1, max: 10_000, step: 0.1 },
  lv4: { value: 30, min: 0.1, max: 10_000, step: 0.1 },
  lv5: { value: 100, min: 0.1, max: 10_000, step: 0.1 },
}
export const LEVELS = ['lv2', 'lv3', 'lv4', 'lv5']
// 設定檔可能被手改壞：每一項不是數字、超出範圍、天數不是整數，就用預設值；
// 體型門檻要一級比一級高，不然四個一起回到預設
export function parseSettings(input) {
  const s = Object.fromEntries(Object.entries(SETTINGS).map(([key, { value, min, max, step }]) => {
    const v = input?.[key]
    return [key, typeof v === 'number' && v >= min && v <= max && (step < 1 || Number.isInteger(v)) ? v : value]
  }))
  if (LEVELS.some((key, i) => i && s[key] <= s[LEVELS[i - 1]])) for (const key of LEVELS) s[key] = SETTINGS[key].value
  return s
}

const DAY = 864e5
const days = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / DAY)
export const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s)) && new Date(s).toISOString().startsWith(s)
export const addDays = (date, n) => new Date(Date.parse(date) + n * DAY).toISOString().slice(0, 10)

// ponytail: 不支援引號欄位；schema 的欄位本來就不含逗號
export function parseLedger(text) {
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  if (lines[0].replace(/\s/g, '') !== HEADER) throw new Error(`第 1 行應為標頭：${HEADER}`)
  return lines.slice(1).flatMap((line, i) => {
    if (!line.trim()) return []
    const cells = line.split(',').map(s => s.trim())
    const [date, symbol, action] = cells
    const [shares, amount, fee] = cells.slice(3).map(Number)
    const ok = cells.length === 6 && isDate(date) && symbol && ACTIONS.includes(action) &&
      [shares, amount, fee].every(n => Number.isFinite(n) && n >= 0)
    if (!ok) throw new Error(`第 ${i + 2} 行格式錯誤：${line}`)
    return [{ date, symbol, action, shares, amount, fee }]
  })
}

const toLine = r => [r.date, r.symbol, r.action, r.shares, r.amount, r.fee].join(',')
// 同一天先算買進、再算股利、最後算賣出：當沖（甚至先賣後買）的賣出才不會因為「那時還沒持股」被略過，留下幽靈持股
const SAME_DAY = { buy: 0, dividend: 1, sell: 2 }
const byDate = (a, b) => a.date.localeCompare(b.date) || SAME_DAY[a.action] - SAME_DAY[b.action]

export const toCsv = rows => [HEADER, ...rows.map(toLine)].join('\n') + '\n'

// rows 裡沒被 against 對到的那些（多重集合：同一筆出現兩次就要對到兩次）
function unmatched(rows, against) {
  const count = new Map()
  for (const r of against) count.set(toLine(r), (count.get(toLine(r)) ?? 0) + 1)
  return rows.filter(r => {
    const n = count.get(toLine(r)) ?? 0
    count.set(toLine(r), n - 1)
    return n <= 0
  })
}

// 合併匯入：重複匯入同一份檔案不會多出資料，同一天兩筆一樣的買入也不會被吃掉
export const mergeLedger = (existing, incoming) => [...existing, ...unmatched(incoming, existing)].sort(byDate)

// 拿掉上次同步寫進來的那批（每筆只拿掉一次；已經被手動刪掉的就略過）
export const removeRows = (ledger, rows) => unmatched(ledger, rows)

// market（可省略）：{ date, indexChange: 加權指數漲跌 %, prices: { 代號: { close, change } } }
function marketMood(holdings, market, s) {
  if (!market) return { weather: null, mood: null, fur: null }
  const weather = market.indexChange >= 0 ? 'sunny' : market.indexChange > -s.typhoon ? 'rain' : 'typhoon'
  let value = 0, prev = 0, cost = 0
  for (const [symbol, h] of holdings) {
    const p = market.prices[symbol]
    if (!p || !h.shares) continue // 查不到收盤價的（例如海外資產）不列入
    value += h.shares * p.close
    prev += h.shares * (p.close - p.change)
    cost += h.cost
  }
  if (!value) return { weather, mood: null, fur: null }
  const day = (value / prev - 1) * 100
  const gain = (value / cost - 1) * 100
  return {
    weather,
    mood: day >= s.mood ? 'happy' : day <= -s.mood ? 'sad' : 'calm',
    fur: gain >= s.fur ? 'shiny' : gain <= -s.fur ? 'dull' : 'normal',
  }
}

// settings（可省略）：使用者的寵物設定，見 SETTINGS；缺的、壞的用預設值
export function evaluate(ledger, today, market = null, settings = {}) {
  const s = parseSettings(settings)
  const holdings = new Map() // symbol → { shares, cost }
  let firstBuy, lastBuy
  for (const r of [...ledger].sort(byDate)) {
    if (r.date > today) break // 可回放：只看 today 以前的紀錄
    const h = holdings.get(r.symbol) ?? { shares: 0, cost: 0 }
    if (r.action === 'buy') {
      h.shares += r.shares
      h.cost += r.amount + r.fee
      firstBuy ??= r.date
      lastBuy = r.date
    } else if (r.action === 'sell' && h.shares > 0) {
      // 本金按平均成本扣除，賣在高點或低點都不影響剩下的體型
      const sold = Math.min(r.shares, h.shares)
      h.cost -= (h.cost * sold) / h.shares
      h.shares -= sold
    }
    holdings.set(r.symbol, h)
  }
  const env = { ...marketMood(holdings, market, s), marketDate: market?.date ?? null, indexChange: market?.indexChange ?? null }
  if (!firstBuy) return { stage: 'none', age: 0, size: 1, satiety: 3, ...env }

  const principal = [...holdings.values()].reduce((s, h) => s + h.cost, 0)
  const age = days(firstBuy, today)
  const missed = Math.floor((days(lastBuy, today) - s.grace) / s.period)
  return {
    stage: age < HATCH_DAYS ? 'egg' : age < ADULT_DAYS ? 'baby' : 'adult',
    age,
    size: 1 + LEVELS.filter(key => principal >= s[key] * 10_000).length,
    satiety: Math.min(3, Math.max(0, 3 - missed)), // 3 = 飽，漏一期少一碗，最低 0（不會死）
    ...env,
  }
}
