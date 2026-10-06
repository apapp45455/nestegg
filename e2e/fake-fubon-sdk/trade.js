// Fake Fubon SDK for end-to-end tests: same interface as CoreSdk in the real trade.js, but offline and returning fixed trade records.
// Tests can put files in this folder: fail-login simulates a login failure, hold-login holds login (simulating a sync in progress), fail-logout makes logout throw, and fail-query makes queries throw (simulating a dropped connection).
// Permissions follow the API key's name, like the real 證券下單 / 證券業務 checkboxes: only keys containing "history" may query
// the trade history, and keys containing "no-accounting" may not query holdings. positions.json overrides the holdings,
// and every login's key is appended to logins.txt. throttle-once makes one query answer 業務系統流量控管.
const fs = require('node:fs')
const path = require('node:path')

const FILLS = [
  ['2025/11/06', 'Buy', 'Stock', 150, 64.0], ['2025/12/08', 'Buy', 'Stock', 148, 65.1],
  ['2026/01/06', 'Buy', 'Stock', 145, 66.2], ['2026/02/06', 'Buy', 'Stock', 140, 68.5],
  ['2026/03/06', 'Buy', 'Margin', 1000, 70.0], ['2026/03/06', 'Buy', 'Stock', 139, 69.0],
  ['2026/04/07', 'Buy', 'Stock', 141, 68.0], ['2026/05/06', 'Buy', 'Stock', 138, 69.6],
  ['2026/06/08', 'Buy', 'Stock', 135, 71.0], ['2026/07/06', 'Buy', 'Stock', 133, 72.3],
  ['2026/08/06', 'Buy', 'Stock', 130, 73.8], ['2026/09/07', 'Buy', 'Stock', 129, 74.4],
].map(([date, buySell, orderType, filledQty, filledPrice]) => ({ date, stockNo: '0050', buySell, orderType, filledQty, filledPrice }))

// Holdings that match FILLS: the cash shares at the same rounded cost the ledger rows get, plus the margin position
const cash = FILLS.filter(f => f.orderType === 'Stock')
const shares = cash.reduce((n, f) => n + f.filledQty, 0)
const HOLDINGS = [
  { stockNo: '0050', orderType: 'Stock', todayQty: shares, costPrice: cash.reduce((n, f) => n + Math.round(f.filledPrice * f.filledQty), 0) / shares },
  { stockNo: '0050', orderType: 'Margin', todayQty: 1000, costPrice: 70 },
]
const DENIED = { isSuccess: false, message: '此 API KEY 未授權該功能' } // what the real API answers
// throttle-once: one query answers 業務系統流量控管, like the real API does when queried too quickly.
// The file may name the window's start date (YYYYMMDD) to throttle; empty means the next query
const throttled = from => {
  const file = path.join(__dirname, 'throttle-once')
  if (!fs.existsSync(file)) return false
  const at = fs.readFileSync(file, 'utf8').trim()
  if (at && at !== from) return false
  fs.rmSync(file)
  return true
}
const THROTTLED = { isSuccess: false, message: '業務系統流量控管' }

class CoreSdk {
  constructor(version) { this.version = version }
  apikeyLogin(id, apiKey, certPath) {
    // hold-login: write login-started so the test knows login has begun (the main process has marked the sync as running), then wait until the test removes hold-login (at most 30 seconds)
    if (fs.existsSync(path.join(__dirname, 'hold-login'))) {
      fs.writeFileSync(path.join(__dirname, 'login-started'), '')
      for (const end = Date.now() + 30_000; fs.existsSync(path.join(__dirname, 'hold-login')) && Date.now() < end;) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
      }
    }
    fs.appendFileSync(path.join(__dirname, 'logins.txt'), `${apiKey}\n`)
    this.apiKey = apiKey
    if (fs.existsSync(path.join(__dirname, 'fail-login'))) return { isSuccess: false, message: 'API Key 無效（假的）' }
    if (!fs.existsSync(certPath)) return { isSuccess: false, message: '找不到憑證' }
    return { isSuccess: true, data: [
      { name: '測試', account: '1', branchNo: '0', accountType: 'stock' },
      { name: '期貨', account: '2', branchNo: '0', accountType: 'futopt' },
    ] }
  }
  get stock() {
    const key = d => d.replaceAll('/', '')
    return {
      filledHistory: (_account, from, to) => {
        if (fs.existsSync(path.join(__dirname, 'fail-query'))) throw new Error('連線中斷（假的）')
        if (!this.apiKey.includes('history')) return DENIED
        if (throttled(from)) return THROTTLED
        return { isSuccess: true, data: FILLS.filter(f => key(f.date) >= from && key(f.date) <= to) }
      },
    }
  }
  get accounting() {
    return {
      unrealizedGainsAndLoses: () => {
        if (fs.existsSync(path.join(__dirname, 'fail-query'))) throw new Error('連線中斷（假的）')
        if (this.apiKey.includes('no-accounting')) return DENIED
        const file = path.join(__dirname, 'positions.json')
        return { isSuccess: true, data: fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : HOLDINGS }
      },
    }
  }
  logout() {
    if (fs.existsSync(path.join(__dirname, 'fail-logout'))) throw new Error('登出失敗（假的）')
    return true
  }
}

module.exports = { CoreSdk, HOLDINGS }
