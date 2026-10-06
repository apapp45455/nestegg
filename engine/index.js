// Pet engine: pure functions, no hidden state. Same ledger + same day + same market data = same pet.
// Growth only depends on what the user controls (time, contributions); market moves only affect weather, mood and fur, never growth or health.

export const HEADER = 'date,symbol,action,shares,amount,fee'
const ACTIONS = ['buy', 'sell', 'dividend']

// Rules table (Phase 0): tune the numbers here. Hatching and growing up depend only on time and aren't user-adjustable (adjusting them would make raising the pet meaningless)
export const HATCH_DAYS = 7 // Days after the first buy until hatching
export const ADULT_DAYS = 365 // Days until adulthood

// What users can adjust in pet settings (stored in settings.json); value is the default
export const SETTINGS = {
  period: { value: 31, min: 7, max: 92, step: 1 }, // Contribution period (days): monthly 31, weekly 7, quarterly 92
  grace: { value: 7, min: 0, max: 30, step: 1 }, // Grace days for debit dates that fall on holidays and late syncs
  typhoon: { value: 3, min: 0.5, max: 10, step: 0.5 }, // TAIEX one-day drop of at least this % → typhoon (other drops → rain)
  mood: { value: 1, min: 0.1, max: 10, step: 0.1 }, // Holdings' one-day change of at least ± this % → happy / sad
  fur: { value: 5, min: 0.5, max: 50, step: 0.5 }, // Holdings' market value at least ± this % from cost → shiny / dull fur
  // Principal (in units of NT$10,000) needed for each size level (Lv1 → Lv5); adjustable because people's asset levels differ widely
  lv2: { value: 3, min: 0.1, max: 10_000, step: 0.1 },
  lv3: { value: 10, min: 0.1, max: 10_000, step: 0.1 },
  lv4: { value: 30, min: 0.1, max: 10_000, step: 0.1 },
  lv5: { value: 100, min: 0.1, max: 10_000, step: 0.1 },
}
export const LEVELS = ['lv2', 'lv3', 'lv4', 'lv5']
// The settings file may be edited badly by hand: any value that isn't a number, is out of range, or is a non-integer day count falls back to its default;
// size thresholds must increase level by level, otherwise all four fall back to the defaults
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

// ponytail: quoted fields aren't supported; no field in the schema contains commas
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
// Within a day, apply buys, then dividends, then sells: otherwise a day trade's sell (even sell-before-buy) is skipped as "nothing held yet", leaving phantom shares
const SAME_DAY = { buy: 0, dividend: 1, sell: 2 }
const byDate = (a, b) => a.date.localeCompare(b.date) || SAME_DAY[a.action] - SAME_DAY[b.action]

export const toCsv = rows => [HEADER, ...rows.map(toLine)].join('\n') + '\n'

// The rows not matched by `against` (as a multiset: a row that appears twice must be matched twice)
function unmatched(rows, against) {
  const count = new Map()
  for (const r of against) count.set(toLine(r), (count.get(toLine(r)) ?? 0) + 1)
  return rows.filter(r => {
    const n = count.get(toLine(r)) ?? 0
    count.set(toLine(r), n - 1)
    return n <= 0
  })
}

// Merge an import: importing the same file again adds nothing, and two identical buys on the same day are both kept
export const mergeLedger = (existing, incoming) => [...existing, ...unmatched(incoming, existing)].sort(byDate)

// Remove the batch the last sync wrote (each row once; rows already deleted by hand are skipped)
export const removeRows = (ledger, rows) => unmatched(ledger, rows)

// market (optional): { date, indexChange: TAIEX change in %, prices: { code: { close, change } } }
function marketMood(holdings, market, s) {
  if (!market) return { weather: null, mood: null, fur: null }
  const weather = market.indexChange >= 0 ? 'sunny' : market.indexChange > -s.typhoon ? 'rain' : 'typhoon'
  let value = 0, prev = 0, cost = 0
  for (const [symbol, h] of holdings) {
    const p = market.prices[symbol]
    if (!p || !h.shares) continue // Holdings without a closing price (for example, overseas assets) are left out
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

// settings (optional): the user's pet settings, see SETTINGS; missing or bad values use the defaults
// Shares and principal per symbol after replaying the ledger up to `today` (replayable: later records don't count)
// cost is what the shares cost; amountOnly is principal recorded without shares (recurring plans), kept apart so it
// doesn't skew the market value comparison and no sell of the recorded shares takes it away
export function holdings(ledger, today) {
  const held = new Map() // symbol → { shares, cost, amountOnly }
  for (const r of [...ledger].sort(byDate)) {
    if (r.date > today) break
    const h = held.get(r.symbol) ?? { shares: 0, cost: 0, amountOnly: 0 }
    if (r.action === 'buy' && !r.shares) {
      h.amountOnly += r.amount + r.fee
    } else if (r.action === 'buy') {
      h.shares += r.shares
      h.cost += r.amount + r.fee
    } else if (r.action === 'sell' && h.shares > 0) {
      // Principal is reduced at average cost, so selling high or low doesn't change the remaining size
      const sold = Math.min(r.shares, h.shares)
      h.cost -= (h.cost * sold) / h.shares
      h.shares -= sold
    }
    held.set(r.symbol, h)
  }
  return held
}

export function evaluate(ledger, today, market = null, settings = {}) {
  const s = parseSettings(settings)
  const held = holdings(ledger, today)
  const buys = ledger.filter(r => r.action === 'buy' && r.date <= today).map(r => r.date).sort()
  const [firstBuy, lastBuy] = [buys[0], buys.at(-1)]
  const env = { ...marketMood(held, market, s), marketDate: market?.date ?? null, indexChange: market?.indexChange ?? null }
  if (!firstBuy) return { stage: 'none', age: 0, size: 1, satiety: 3, ...env }

  const principal = [...held.values()].reduce((s, h) => s + h.cost + h.amountOnly, 0)
  const age = days(firstBuy, today)
  const missed = Math.floor((days(lastBuy, today) - s.grace) / s.period)
  return {
    stage: age < HATCH_DAYS ? 'egg' : age < ADULT_DAYS ? 'baby' : 'adult',
    age,
    size: 1 + LEVELS.filter(key => principal >= Math.round(s[key] * 10_000)).length, // A hand-edited 0.14 × 10,000 would be 1400.0000000000002
    satiety: Math.min(3, Math.max(0, 3 - missed)), // 3 = full, one bowl less per missed period, minimum 0 (it never dies)
    ...env,
  }
}

// Recurring contributions (定期定額計畫): a plan records the same NT$ amount on the same day every month, so people
// whose broker can't be synced (for example US stocks bought through 複委託) don't have to enter each one.
// Plans live in their own file and are expanded on the fly, so editing or deleting one never leaves stale ledger rows.
// Only the money counts (shares: 0): enough for age, fullness and size; mood and fur need prices anyway.
// The UI saves only valid plans; a plan file edited badly by hand throws, and the pet shows the error like a bad ledger.
export function parsePlans(input) {
  if (!Array.isArray(input)) throw new Error('定期定額計畫的格式不對')
  return input.map((p, i) => {
    const plan = {
      symbol: String(p?.symbol ?? '').trim().toUpperCase(),
      amount: Number(p?.amount),
      day: Number(p?.day),
      start: String(p?.start ?? ''),
      end: p?.end ? String(p.end) : null,
    }
    const problem =
      !/^[0-9A-Z][0-9A-Z.-]{0,11}$/.test(plan.symbol) ? '請填標的代號，例如 0050 或 VOO'
        : !(Number.isInteger(plan.amount) && plan.amount > 0) ? '每月金額要是大於 0 的整數（台幣）'
          : !(Number.isInteger(plan.day) && plan.day >= 1 && plan.day <= 31) ? '扣款日要是 1 到 31'
            : !isDate(plan.start) ? '請選開始日期'
              : plan.end && !(isDate(plan.end) && plan.end >= plan.start) ? '結束日期要在開始日期之後'
                : null
    if (problem) throw new Error(`第 ${i + 1} 個計畫：${problem}`)
    return plan
  })
}

// The ledger rows a list of plans adds up to by `today`: one buy per month on the plan's day (the last day of a
// shorter month), from the start date through the end date if any
export function planRows(plans, today) {
  const rows = []
  for (const p of plans) {
    const last = p.end && p.end < today ? p.end : today
    for (let y = +p.start.slice(0, 4), m = +p.start.slice(5, 7); ; m === 12 ? (y++, m = 1) : m++) {
      const day = Math.min(p.day, new Date(Date.UTC(y, m, 0)).getUTCDate())
      const date = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      if (date > last) break
      if (date >= p.start) rows.push({ date, symbol: p.symbol, action: 'buy', shares: 0, amount: p.amount, fee: 0 })
    }
  }
  return rows
}
