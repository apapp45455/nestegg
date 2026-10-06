// End-to-end tests: really launch NestEgg (main process, pet window, the Fubon sync utility process)
// with a temp folder, a fake Fubon SDK, a fake Shioaji server and pre-seeded market data: no network, and real user data is never touched.
// Run: npm run test:e2e (works on macOS and Windows; CI runs it too)
import { app, BrowserWindow, dialog, ipcMain, screen } from 'electron'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA = mkdtempSync(join(tmpdir(), 'nestegg-e2e-'))
const SDK = join(DATA, 'fubon', 'package')
app.setPath('userData', DATA)

// Market cache: freshly fetched, so the app stays offline; 0050 closed at 112, up 2 (110 the day before)
writeFileSync(join(DATA, 'market.json'), JSON.stringify({
  date: '2026-10-02', indexChange: 1.2, prices: { '0050': { close: 112, change: 2 } }, fetchedAt: Date.now(),
}))
// Put the fake Fubon SDK straight into the installed location (the install flow opens a file dialog; it's stubbed in its own test)
mkdirSync(SDK, { recursive: true })
cpSync(join(import.meta.dirname, 'fake-fubon-sdk'), SDK, { recursive: true })
const CERT = join(DATA, 'test-cert.pfx')
writeFileSync(CERT, 'not a real certificate')
const { HOLDINGS } = createRequire(import.meta.url)(join(SDK, 'trade.js'))
const { dateWindows } = await import('../sync/fubon.js')
const logins = () => readFileSync(join(SDK, 'logins.txt'), 'utf8').trim().split('\n')
// Local date, like the app's today()
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 6e4).toISOString().slice(0, 10)
// Sinopac: pretend the Shioaji command-line program is installed; the step that really starts the server is replaced by the fake server below
const SHIOAJI = join(DATA, 'sinopac', 'package')
mkdirSync(SHIOAJI, { recursive: true })
writeFileSync(join(SHIOAJI, process.platform === 'win32' ? 'shioaji.exe' : 'shioaji'), '')
writeFileSync(join(SHIOAJI, 'version.txt'), '1.7.7-fake')

// Fake local Shioaji API server: answers account queries and records which paths were called
const shioaji = { simulation: false, calls: [], positions: [], positionDetails: {}, profitLoss: [], profitDetails: {} }
const fakeShioaji = createServer((req, res) => {
  let body = ''
  req.on('data', d => (body += d)).on('end', () => {
    const json = body ? JSON.parse(body) : {}
    shioaji.calls.push({ path: req.url, ...json })
    const reply = {
      '/api/v1/info': { simulation: shioaji.simulation },
      '/api/v1/portfolio/position_unit': shioaji.positions,
      '/api/v1/portfolio/position_detail': shioaji.positionDetails[json.detail_id] ?? [],
      '/api/v1/portfolio/profit_loss': shioaji.profitLoss,
      '/api/v1/portfolio/profit_loss_detail': shioaji.profitDetails[json.detail_id] ?? [],
    }[req.url]
    // authError: leak the key in the error message like the real Shioaji does (the whole key plus its first 10 characters in the request ID)
    const key = shioaji.started?.creds.apiKey ?? ''
    if (shioaji.authError) return res.writeHead(401).end(JSON.stringify({ message: `Request #P2P/PYAPI/${key.slice(0, 10)}/1005 error code: 400, detail: key: ${key} not exist.` }))
    res.writeHead(reply ? 200 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply ?? { message: 'not found' }))
  })
}).listen(0, '127.0.0.1')

// Any unhandled error in the main process fails the run (users would see a "JavaScript error" dialog)
const crashes = []
process.on('uncaughtException', e => crashes.push(e.message))
process.on('unhandledRejection', e => crashes.push(String(e?.message ?? e)))
setTimeout(() => { console.error('✖ 逾時'); app.exit(1) }, 120_000)

const { openPlans, openSettings } = await import('../app/main.js')
const { openSetup, syncSaved } = await import('../app/brokers.js') // Calling syncSaved directly = the auto sync path
const { default: sinopac } = await import('../app/brokers/sinopac.js')
let shioajiStops = 0
sinopac.server = async (bin, creds) => {
  shioaji.started = { bin, creds }
  return { url: `http://127.0.0.1:${fakeShioaji.address().port}`, stop: () => shioajiStops++ }
}
// Note: an ESM entry point can't top-level await app.whenReady() (ready only fires after the entry finishes), so wrap it in a function
app.whenReady().then(runAll)

const wait = ms => new Promise(r => setTimeout(r, ms))
const windowAt = file => BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.getURL().endsWith(file))
const win = () => windowAt('/index.html') // The pet
const page = (code, w = win()) => w.webContents.executeJavaScript(code)
async function until(code, ok, label, ms = 15_000, w = win) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(200)) {
    const v = await Promise.resolve().then(() => page(code, w())).catch(() => undefined)
    if (ok(v)) return v
  }
  throw new Error(`等不到：${label}`)
}
// Run fn while a Fubon sync is held at login, then let it continue; returns [fn's result, the sync's result].
// fn only runs once the fake SDK has really entered login, so the main process has definitely marked the sync as running; no timing assumptions (messages from different windows can arrive in any order)
async function duringFubonSync(fn) {
  const hold = join(SDK, 'hold-login'), started = join(SDK, 'login-started')
  rmSync(started, { force: true })
  writeFileSync(hold, '')
  const syncing = page("window.broker.sync('fubon')")
  try {
    for (const end = Date.now() + 15_000; !existsSync(started); await wait(50)) {
      if (Date.now() > end) throw new Error('等不到：富邦開始登入')
    }
    const result = await fn()
    rmSync(hold)
    return [result, await syncing]
  } finally {
    rmSync(hold, { force: true })
  }
}
const ledgerLines = (symbol = '') => {
  const f = join(DATA, 'ledger.csv')
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').slice(1).filter(l => l.includes(symbol)).length : 0
}

async function runAll() {
  const results = []
  async function test(name, fn) {
    try {
      await fn()
      results.push(true)
      console.log(`✔ ${name}`)
    } catch (e) {
      results.push(false)
      console.log(`✖ ${name}\n  ${e.message}`)
    }
  }

  await test('啟動：寵物在主螢幕的可用範圍內，沒有帳本時是蛋與提示', async () => {
    await until('document.readyState', v => v === 'complete', '頁面載入')
    await until('state.stage', v => v === 'none', '沒有帳本的狀態')
    const b = win().getBounds(), a = screen.getPrimaryDisplay().workArea
    assert.ok(b.x >= a.x && b.y >= a.y && b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height, JSON.stringify({ b, a }))
    assert.match(await page('bubble.hidden ? "" : bubble.textContent'), /還沒有交易紀錄/)
  })

  await test('富邦同步：用一次性的歷史金鑰匯入成交紀錄，只算現股、寫進帳本、寵物孵化', async () => {
    const status = await page("window.broker.status('fubon')")
    assert.equal(status.ok.sdk, '2.4.0-fake')
    const badDate = await page(`window.broker.connect('fubon', { id: 'a123456789', apiKey: 'e2e-key', certPath: ${JSON.stringify(CERT)}, since: '2025-02-31' })`)
    assert.match(badDate.error, /起始日期/) // A nonexistent date gets a clear message, not a cryptic RangeError
    // Fubon throttles one query (業務系統流量控管): NestEgg waits, retries and still imports everything
    writeFileSync(join(SDK, 'throttle-once'), dateWindows('2025-10-01', today()).at(-1)[0])
    const res = await page(`window.broker.connect('fubon', { id: 'a123456789', apiKey: 'e2e-key', historyKey: 'history-key', certPath: ${JSON.stringify(CERT)}, certPass: '', since: '2025-10-01' })`)
    assert.equal(res.error, undefined, res.error)
    assert.equal(existsSync(join(SDK, 'throttle-once')), false)
    assert.equal(res.ok.added, 11) // 12 trades; the margin one doesn't count, and the holdings match the history, so reconciling adds nothing
    assert.equal(res.ok.accounts, 1) // The futures account isn't queried
    assert.equal(ledgerLines(), 11)
    await until('state.stage', v => v === 'baby' || v === 'adult', '孵化')
  })

  await test('富邦同步：金鑰加密保存，設定檔裡找不到明文', async () => {
    const cfg = readFileSync(join(DATA, 'fubon', 'config.json'), 'utf8')
    assert.doesNotMatch(cfg, /A123456789|e2e-key/)
    assert.match(JSON.parse(cfg).secret, /^[A-Za-z0-9+/=]{20,}$/)
  })

  await test('富邦同步：再同步一次不會重複；登出失敗也不影響查到的紀錄；歷史金鑰只用了一次', async () => {
    writeFileSync(join(SDK, 'fail-logout'), '')
    try {
      const res = await page("window.broker.sync('fubon')")
      assert.equal(res.error, undefined, res.error)
      assert.equal(res.ok.added, 0)
    } finally {
      rmSync(join(SDK, 'fail-logout'))
    }
    assert.equal(ledgerLines(), 11)
    // The history key was used once while connecting and never saved: daily syncs log in with the 證券業務 key only
    assert.deepEqual(logins(), ['history-key', 'e2e-key', 'e2e-key'])
  })

  await test('富邦對帳：持股變多記成今天買進、變少記成今天賣出，只要「證券業務」權限', async () => {
    const [cash, margin] = HOLDINGS
    const positions = join(SDK, 'positions.json')
    try {
      // Bought 100 more for 11,500; the margin position doesn't count
      const cost = cash.costPrice * cash.todayQty + 11_500
      writeFileSync(positions, JSON.stringify([{ ...cash, todayQty: cash.todayQty + 100, costPrice: cost / (cash.todayQty + 100) }, { ...margin, todayQty: 3000 }]))
      const bought = await page("window.broker.sync('fubon')")
      assert.equal(bought.error, undefined, bought.error)
      assert.equal(bought.ok.added, 1)
      assert.equal(ledgerLines(`${today()},0050,buy,100,11500,0`), 1)
      // Then sold those 100 again: a sell at the recorded average cost
      rmSync(positions)
      const sold = await page("window.broker.sync('fubon')")
      assert.equal(sold.ok.added, 1)
      assert.equal(ledgerLines(`${today()},0050,sell,100,`), 1)
      assert.equal((await page("window.broker.sync('fubon')")).ok.added, 0) // Nothing changed since
    } finally {
      rmSync(positions, { force: true })
    }
    assert.equal(ledgerLines(), 13)
  })

  await test('富邦對帳：自動同步遇到持股全空就停下來請你確認，帳本不動', async () => {
    writeFileSync(join(SDK, 'positions.json'), '[]')
    try {
      await assert.rejects(syncSaved('fubon'), /沒有回傳部分或全部的持股/)
      assert.match((await page("window.broker.status('fubon')")).ok.paused, /沒有回傳部分或全部的持股/)
      assert.equal(ledgerLines(), 13)
    } finally {
      rmSync(join(SDK, 'positions.json'))
    }
    assert.equal((await page("window.broker.sync('fubon')")).ok.added, 0) // Holdings are back: the manual sync resumes
    assert.equal((await page("window.broker.status('fubon')")).ok.paused, undefined)
  })

  await test('富邦：金鑰權限不夠時說清楚缺哪個權限，也不會存下新的金鑰', async () => {
    const config = () => readFileSync(join(DATA, 'fubon', 'config.json'), 'utf8')
    const before = config()
    const connect = (apiKey, historyKey) =>
      page(`window.broker.connect('fubon', { id: 'a123456789', apiKey: '${apiKey}', historyKey: '${historyKey}', certPath: ${JSON.stringify(CERT)}, certPass: '', since: '2025-10-01' })`)
    assert.match((await connect('e2e-key', 'plain-key')).error, /歷史匯入用的 API Key 沒有「證券下單」權限/)
    assert.match((await connect('no-accounting-key', '')).error, /沒有「證券業務」權限/)
    assert.equal(config(), before)
    assert.equal(ledgerLines(), 13)
  })

  await test('富邦：之後才用歷史金鑰重新連線，歷史取代之前對帳記下的紀錄，不會重複算', async () => {
    // First connect without history: holdings already recorded become one buy today at Fubon's cost
    const connect = historyKey =>
      page(`window.broker.connect('fubon', { id: 'a123456789', apiKey: 'e2e-key', historyKey: '${historyKey}', certPath: ${JSON.stringify(CERT)}, certPass: '', since: '2025-10-01' })`)
    rmSync(join(DATA, 'fubon', 'rows.json'))
    writeFileSync(join(DATA, 'ledger.csv'), readFileSync(join(DATA, 'ledger.csv'), 'utf8').split('\n').filter(l => !l.includes(',0050,')).join('\n'))
    const fresh = await connect('')
    assert.equal(fresh.error, undefined, fresh.error)
    assert.deepEqual([fresh.ok.added, ledgerLines(',0050,'), ledgerLines(`${today()},0050,buy,${HOLDINGS[0].todayQty},`)], [1, 1, 1])
    // Then import the history from the connected page (saved keys plus the history key): the real trades replace
    // that buy, and the holdings match, so nothing else is added
    const history = await page(`window.broker.connect('fubon', { historyKey: 'history-key', since: '2025-10-01', keepKeys: true })`)
    assert.equal(history.error, undefined, history.error)
    assert.deepEqual([ledgerLines(',0050,'), ledgerLines(`${today()},0050,`)], [11, 0])
    assert.equal(logins().at(-1), 'e2e-key') // The history key was used once; the saved daily key is unchanged
    assert.equal((await page("window.broker.sync('fubon')")).ok.added, 0)
    assert.equal(logins().at(-1), 'e2e-key')
  })

  await test('富邦同步：同步中按「連線並同步」會被擋下，不會拿到舊結果、也不會蓋掉儲存的金鑰', async () => {
    const secret = () => JSON.parse(readFileSync(join(DATA, 'fubon', 'config.json'), 'utf8')).secret
    const before = secret()
    const [res, synced] = await duringFubonSync(() =>
      page(`window.broker.connect('fubon', { id: 'b123456789', apiKey: 'other-key', certPath: ${JSON.stringify(CERT)}, certPass: '', since: '2025-10-01' })`))
    assert.match(res.error ?? '', /正在同步中/)
    assert.equal(synced.ok?.added, 0)
    assert.equal(secret(), before)
  })

  await test('富邦同步：斷線這種暫時的錯誤不暫停自動同步，下個小時會再試', async () => {
    writeFileSync(join(SDK, 'fail-query'), '')
    try {
      const res = await page("window.broker.sync('fubon')")
      assert.match(res.error, /連線中斷/)
    } finally {
      rmSync(join(SDK, 'fail-query'))
    }
    assert.equal((await page("window.broker.status('fubon')")).ok.paused, undefined)
    assert.equal(ledgerLines(), 11)
  })

  await test('富邦同步：登入失敗時暫停自動同步、帳本不變', async () => {
    writeFileSync(join(SDK, 'fail-login'), '')
    const res = await page("window.broker.sync('fubon')")
    assert.match(res.error, /登入失敗/)
    assert.match((await page("window.broker.status('fubon')")).ok.paused, /登入失敗/)
    assert.equal(ledgerLines(), 11)
  })

  await test('永豐同步：用持倉明細拼回買進紀錄，只算現股，只呼叫帳務查詢', async () => {
    // 2890 was bought in two lots of 1000 shares (details in board lots); 2330 is on margin and doesn't count
    shioaji.positions = [
      { id: 0, code: '2890', direction: 'Buy', quantity: 2000, price: 30, cond: 'Cash' },
      { id: 1, code: '2330', direction: 'Buy', quantity: 1000, price: 1000, cond: 'MarginTrading' },
    ]
    shioaji.positionDetails = { 0: [{ date: '2026-04-01', quantity: 1 }, { date: '2026-04-15', quantity: 1 }], 1: [{ date: '2026-05-01', quantity: 1 }] }
    const res = await page(`window.broker.connect('sinopac', { apiKey: 'sj-key', secretKey: 'sj-secret', since: '2025-10-01' })`)
    assert.equal(res.error, undefined, res.error)
    assert.equal(res.ok.added, 2)
    assert.equal(ledgerLines(',2890,buy,1000,30000,'), 2)
    assert.equal(ledgerLines(',2330,'), 0)
    assert.deepEqual(shioaji.started.creds, { apiKey: 'sj-key', secretKey: 'sj-secret' })
    assert.equal(shioajiStops, 1) // The server is shut down after the queries
    assert.ok(shioaji.calls.every(c => c.path === '/api/v1/info' || (c.path.startsWith('/api/v1/portfolio/') && c.account_type === 'S')), JSON.stringify(shioaji.calls))
    assert.equal(shioaji.calls.find(c => c.path.endsWith('/profit_loss')).begin_date, '2025-10-01')
    assert.doesNotMatch(readFileSync(join(DATA, 'sinopac', 'config.json'), 'utf8'), /sj-key|sj-secret/)
  })

  await test('永豐同步：賣掉一部分後，整批換成新的紀錄，不會重複', async () => {
    shioaji.positions = [{ id: 0, code: '2890', direction: 'Buy', quantity: 1000, price: 30, cond: 'Cash' }]
    shioaji.positionDetails = { 0: [{ date: '2026-04-15', quantity: 1 }] }
    shioaji.profitLoss = [{ id: 0, code: '2890', quantity: 1000, price: 35, date: '2026-06-01', cond: 'Cash' }]
    shioaji.profitDetails = { 0: [{ date: '2026-04-01', quantity: 1, price: 30, fee: 42, cond: 'Cash' }] }
    const res = await page("window.broker.sync('sinopac')")
    assert.equal(res.error, undefined, res.error)
    assert.equal(res.ok.added, 2) // The new sell and the buy with fees; the unchanged row doesn't count (it used to be counted as a net gain of 1)
    assert.equal(ledgerLines(',2890,'), 3)
    assert.equal(ledgerLines('2026-04-01,2890,buy,1000,30000,42'), 1)
    assert.equal(ledgerLines('2026-04-15,2890,buy,1000,30000,0'), 1)
    assert.equal(ledgerLines('2026-06-01,2890,sell,1000,35000,0'), 1)
  })

  await test('兩家券商同時同步：各自拿到自己的結果，帳本兩邊的紀錄都在', async () => {
    rmSync(join(SDK, 'fail-login'))
    shioaji.positions.push({ id: 1, code: '2884', direction: 'Buy', quantity: 1000, price: 30, cond: 'Cash' })
    shioaji.positionDetails[1] = [{ date: '2026-07-01', quantity: 1 }]
    try {
      const [sinopacRes, fubonRes] = await duringFubonSync(() => page("window.broker.sync('sinopac')")) // Fubon is held at login while Sinopac syncs
      assert.equal(sinopacRes.error, undefined, sinopacRes.error)
      assert.equal(sinopacRes.ok.added, 1) // Not the result of the Fubon sync
      assert.equal(fubonRes.error, undefined, fubonRes.error)
      assert.equal(fubonRes.ok.added, 0)
    } finally {
      writeFileSync(join(SDK, 'fail-login'), '') // Restore the state from earlier tests
    }
    assert.equal(ledgerLines(',2884,'), 1)
    assert.equal(ledgerLines(',0050,'), 11)
  })

  await test('永豐同步：上次同步的紀錄檔壞掉就停下來、帳本不動（不猜，免得本金重複）', async () => {
    const file = join(DATA, 'sinopac', 'rows.json')
    const saved = readFileSync(file, 'utf8')
    writeFileSync(file, '[{ 壞掉')
    try {
      const res = await page("window.broker.sync('sinopac')")
      assert.match(res.error, /紀錄檔損壞/)
      assert.match((await page("window.broker.status('sinopac')")).ok.paused, /紀錄檔損壞/)
    } finally {
      writeFileSync(file, saved)
    }
    assert.equal(ledgerLines(',2890,'), 3)
    assert.equal(ledgerLines(',2884,'), 1)
  })

  await test('永豐同步：自動同步遇到全空就停下來請你確認、帳本不動；按「立即同步」確認後才清掉', async () => {
    const { positions, profitLoss } = shioaji
    Object.assign(shioaji, { positions: [], profitLoss: [] })
    try {
      await assert.rejects(syncSaved('sinopac'), /如果你已經全部賣出/)
      assert.equal(ledgerLines(',2890,'), 3)
      assert.match((await page("window.broker.status('sinopac')")).ok.paused, /全部賣出/)
      const res = await page("window.broker.sync('sinopac')") // The user pressing "sync now" = confirmation
      assert.equal(res.error, undefined, res.error)
      assert.equal(ledgerLines(',2890,') + ledgerLines(',2884,'), 0)
    } finally {
      Object.assign(shioaji, { positions, profitLoss })
    }
    assert.equal((await page("window.broker.sync('sinopac')")).error, undefined) // Data is back for the following tests
    assert.equal(ledgerLines(',2890,'), 3)
    assert.equal(ledgerLines(',2884,'), 1)
  })

  await test('永豐同步：某檔暫時查不到明細時沿用上一次的紀錄，帳本裡的買進不會消失', async () => {
    const details = shioaji.positionDetails[0]
    shioaji.positionDetails[0] = [] // 2890's position details are temporarily missing
    try {
      const res = await page("window.broker.sync('sinopac')")
      assert.equal(res.error, undefined, res.error)
      assert.match(res.ok.warnings.join(), /2890 查不到買進日期/)
    } finally {
      shioaji.positionDetails[0] = details
    }
    assert.equal(ledgerLines(',2890,'), 3)
    assert.equal(ledgerLines(',2884,'), 1)
  })

  await test('永豐同步：你自己記過的相同紀錄不歸同步管，永豐不再回傳時也不會被刪掉', async () => {
    const mine = '2026-08-01,2412,buy,1000,120000,0'
    writeFileSync(join(DATA, 'ledger.csv'), readFileSync(join(DATA, 'ledger.csv'), 'utf8').trimEnd() + `\n${mine}\n`) // A manual ledger entry
    shioaji.positions.push({ id: 9, code: '2412', direction: 'Buy', quantity: 1000, price: 120, cond: 'Cash' })
    shioaji.positionDetails[9] = [{ date: '2026-08-01', quantity: 1 }]
    try {
      assert.equal((await page("window.broker.sync('sinopac')")).ok.added, 0) // Same as the manual entry, so deduplicated
      assert.equal(ledgerLines(mine), 1)
    } finally {
      shioaji.positions.pop()
      delete shioaji.positionDetails[9]
    }
    assert.equal((await page("window.broker.sync('sinopac')")).error, undefined) // Sinopac no longer returns 2412
    assert.equal(ledgerLines(mine), 1)
    assert.equal(ledgerLines(',2890,'), 3)
  })

  await test('永豐同步：上次寫完帳本、還沒記好就當機（紀錄檔裡新舊兩批都在），下次同步也不會重複', async () => {
    const rows = JSON.parse(readFileSync(join(DATA, 'sinopac', 'rows.json'), 'utf8'))
    const stale = [{ date: '2026-04-01', symbol: '2890', action: 'buy', shares: 1000, amount: 30000, fee: 0 }]
    writeFileSync(join(DATA, 'sinopac', 'rows.json'), JSON.stringify([...stale, ...rows]))
    const res = await page("window.broker.sync('sinopac')")
    assert.equal(res.error, undefined, res.error)
    assert.equal(ledgerLines(',2890,'), 3)
    assert.equal(ledgerLines(',2884,'), 1)
  })

  await test('永豐同步：Shioaji 跑在模擬環境時拒絕匯入', async () => {
    shioaji.simulation = true
    const res = await page("window.broker.sync('sinopac')")
    assert.match(res.error, /模擬環境/)
    assert.equal(ledgerLines(',2890,'), 3)
  })

  await test('永豐同步：錯誤訊息帶出金鑰時遮掉，畫面與設定檔都看不到', async () => {
    const key = '4t1kkLTbjrxPJcxg2y8baZBA1142BBqXKxMdAyK3qLKb' // Real keys look like this (the sj-key used earlier is too short to be treated as a key)
    const connect = `window.broker.connect('sinopac', { apiKey: '${key}', secretKey: 'sj-secret', since: '2025-10-01' })`
    shioaji.simulation = false
    assert.equal((await page(connect)).error, undefined) // Save this key first
    shioaji.authError = true
    try {
      const res = await page(connect)
      assert.match(res.error, /key: \*\*\* not exist/)
      assert.ok(!res.error.includes(key.slice(0, 10)), res.error)
      // Auto sync (with the saved key) hits the same error: the pause reason goes into the config file, which must not contain the key either
      await assert.rejects(syncSaved('sinopac'), e => e.needsUser === true && !e.stack.includes(key.slice(0, 10))) // console.error prints the stack
      const config = readFileSync(join(DATA, 'sinopac', 'config.json'), 'utf8')
      assert.match(config, /key: \*\*\* not exist/)
      assert.ok(!config.includes(key.slice(0, 10)), config)
    } finally {
      shioaji.authError = false
    }
  })

  await test('行情：天氣、心情、毛色跟著快取的行情走', async () => {
    // Cost about 69 per share, close 112 → shiny fur; up 2/110 ≈ +1.8% → happy; TAIEX +1.2% → sunny
    const s = await until('state', v => v?.weather, '行情狀態')
    assert.deepEqual([s.weather, s.mood, s.fur], ['sunny', 'happy', 'shiny'])
    assert.equal(await page('sky.hidden'), false)
  })

  await test('寵物設定：改了就存、寵物馬上跟著變；超出範圍的不存；恢復預設', async () => {
    openSettings()
    const settings = () => windowAt('/settings.html')
    const file = join(DATA, 'settings.json')
    await until('document.querySelector("[name=mood]").value', v => v === '1', '設定載入', 15_000, settings)
    const set = (name, value) => page(`(el => { el.value = ${JSON.stringify(value)}; el.dispatchEvent(new Event('change', { bubbles: true })) })(document.querySelector('[name=${name}]')); 0`, settings())
    // Holdings are +1.8% today: with the threshold at 2% the pet isn't happy any more
    await set('mood', '2')
    await until('state.mood', v => v === 'calm', '心情變平靜')
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { mood: 2 }) // Only changed values are saved
    await set('period', '7')
    await until('JSON.stringify(state)', () => JSON.parse(readFileSync(file, 'utf8')).period === 7, '週期存檔')
    // Out of range: not saved, file unchanged
    await set('fur', '500')
    await wait(500)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { mood: 2, period: 7 })
    await set('fur', '5')
    // Lower size thresholds (in units of NT$10,000): same principal, and the pet grows to Lv5 right away
    const size = await page('state.size')
    assert.ok(size < 5, `預設門檻下是 Lv${size}`)
    for (const [i, v] of ['0.1', '0.2', '0.3', '0.4'].entries()) await set(`lv${i + 2}`, v)
    await until('state.size', v => v === 5, '長到 Lv5')
    // Not higher than the previous level: not saved
    await set('lv3', '0.1')
    await wait(500)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { mood: 2, period: 7, lv2: 0.1, lv3: 0.2, lv4: 0.3, lv5: 0.4 })
    await set('lv3', '0.2')
    // Rapid saves (without waiting for the previous one): every save succeeds and the last one wins
    const saves = await page('Promise.allSettled([2, 3, 4, 5].map(mood => window.petSettings.set({ mood }))).then(r => r.map(x => x.status))', settings())
    assert.deepEqual(saves, ['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled'])
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { mood: 5 })
    await page('document.getElementById("reset").click()', settings())
    await until('state.mood', v => v === 'happy', '恢復預設後又開心')
    assert.equal(await page('state.size'), size)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), {})
    assert.equal(await page('document.querySelector("[name=fur]").value', settings()), '5')
    // A settings file broken by hand reads back as the defaults (the pet uses the same reader, so it never shows "ledger read failed")
    writeFileSync(file, '{ 壞掉')
    assert.equal(await page('window.petSettings.get().then(r => r.values.mood)', settings()), 1)
    rmSync(file)
    settings().close()
  })

  await test('定期定額計畫：設定一次，每月的投入自動算進寵物；填錯不存；結束或刪除後拿掉', async () => {
    openPlans()
    const plans = () => windowAt('/plans.html')
    const file = join(DATA, 'plans.json')
    await until('document.getElementById("empty").hidden', v => v === false, '計畫視窗載入', 15_000, plans)
    const before = await page('state.size')
    assert.ok(before < 5, `目前是 Lv${before}`)
    const fill = values => page(`(f => { ${Object.entries(values).map(([k, v]) => `f.elements.${k}.value = ${JSON.stringify(v)};`).join(' ')} f.requestSubmit(); 0 })(document.getElementById('add'))`, plans())
    // US stocks through 複委託: NT$30,000 on the 1st of every month for the last two years
    const start = new Date(Date.parse(today()) - 730 * 864e5).toISOString().slice(0, 10)
    await fill({ symbol: 'voo', amount: '30000', day: '1', start })
    await until('state.size', v => v > before, '計畫的投入讓寵物變大')
    assert.equal(JSON.parse(readFileSync(file, 'utf8'))[0].symbol, 'VOO')
    assert.match(await page('document.getElementById("plans").textContent', plans()), /VOO · 每月 1 日 · NT\$30,000.*已記 2[45] 筆/)
    // Invalid in a way the form can't catch (the form itself blocks an amount of 0): not saved, and the window says why
    await fill({ symbol: '台積電', amount: '5000', day: '6', start })
    assert.match(await until('document.getElementById("result").textContent', v => v, '錯誤訊息', 15_000, plans), /第 2 個計畫：請填標的代號/)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).length, 1)
    // Ending the plan two months in keeps only those contributions
    const end = new Date(Date.parse(start) + 60 * 864e5).toISOString().slice(0, 10)
    await page(`(i => { i.value = ${JSON.stringify(end)}; i.dispatchEvent(new Event('change')); 0 })(document.querySelector('#plans input[type=date]'))`, plans())
    await until('document.getElementById("plans").textContent', v => /已記 2 筆，共 NT\$60,000（已結束）/.test(v), '結束後只剩兩筆', 15_000, plans)
    // Deleting it removes the plan and its contributions entirely
    await page('window.confirm = () => true; document.querySelector("#plans button").click(); 0', plans())
    await until('document.getElementById("empty").hidden', v => v === false, '刪除後沒有計畫', 15_000, plans)
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [])
    await until('state.size', v => v === before, '刪除後回到原本的體型')
    // A plan file broken by hand: the pet says so instead of silently shrinking
    writeFileSync(file, '[{ 壞掉')
    await page('window.petSettings.set({}); 0', plans()) // Any save refreshes the pet
    await until('bubble.textContent', v => /定期定額計畫讀取失敗/.test(v ?? ''), '計畫檔壞掉的提示')
    rmSync(file)
    await page('window.petSettings.set({}); 0', plans())
    await until('bubble.hidden', v => v === true, '修好後提示消失')
    plans().close()
  })

  await test('畫面：寵物真的有畫出來', async () => {
    const painted = await page(`(() => {
      const d = pet.getContext('2d').getImageData(0, 0, 16, 16).data
      let n = 0
      for (let i = 3; i < d.length; i += 4) if (d[i]) n++
      return n
    })()`)
    assert.ok(painted > 100, `只有 ${painted} 個像素`)
  })

  await test('Dock／工作列圖示：點了會冒出狀態氣泡', async () => {
    await page('bubble.hidden = true')
    app.emit('activate')
    const text = await until('bubble.hidden ? "" : bubble.textContent', v => v, '狀態氣泡')
    assert.match(text, /第 \d+ 天/)
  })

  await test('換螢幕：視窗跑出畫面時會被擺回來', async () => {
    const a = screen.getPrimaryDisplay().workArea
    win().setBounds({ x: a.x + a.width - 100, y: a.y + a.height - 100, width: 200, height: 300 })
    screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), ['workArea'])
    await wait(200)
    const b = win().getBounds()
    assert.ok(b.x + b.width <= a.x + a.width && b.y + b.height <= a.y + a.height, JSON.stringify({ b, a }))
  })

  await test('安裝 SDK：不是富邦的、版本太舊的都拒絕，原本裝好的不受影響；新版換上去照樣能同步', async () => {
    const pack = (name, pkg) => {
      const dir = join(DATA, name)
      cpSync(join(import.meta.dirname, 'fake-fubon-sdk'), join(dir, 'package'), { recursive: true })
      writeFileSync(join(dir, 'package', 'package.json'), JSON.stringify(pkg))
      execFileSync('tar', ['-czf', join(DATA, `${name}.tgz`), '-C', dir, 'package'])
      return join(DATA, `${name}.tgz`)
    }
    const install = async file => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) // Stands in for the file dialog
      return page("window.broker.installSdk('fubon')")
    }
    assert.match((await install(pack('other', { name: 'other-sdk', version: '9.9.9' }))).error, /不是富邦/)
    assert.match((await install(pack('old', { name: 'fubon-neo', version: '2.0.0' }))).error, /太舊/)
    assert.equal((await page("window.broker.status('fubon')")).ok.sdk, '2.4.0-fake')
    rmSync(join(SDK, 'fail-login')) // The newly swapped-in version doesn't carry files from the old folder
    assert.equal((await install(pack('new', { name: 'fubon-neo', version: '2.5.0-fake' }))).ok, '2.5.0-fake')
    assert.equal(existsSync(join(SDK, 'fail-login')), false)
    assert.equal((await page("window.broker.sync('fubon')")).error, undefined)
  })

  await test('設定精靈：列出券商與狀態，點進去是那家券商的設定頁', async () => {
    openSetup()
    const setup = () => windowAt('/setup.html')
    const list = await until('document.getElementById("brokers").innerText', v => v, '券商清單', 15_000, setup)
    assert.match(list, /富邦證券/)
    assert.match(list, /永豐金證券/)
    assert.match(list, /自動同步已暫停/) // Sinopac: the simulation-mode error from an earlier test
    await page('document.querySelector(".brokers a").click()', setup())
    const fubonPage = () => windowAt('/setup-fubon.html')
    assert.match(await until('document.getElementById("sdk-status").textContent', v => v, 'SDK 狀態', 15_000, fubonPage), /已安裝 v2\.5\.0-fake/)
    // Pressing "clear saved keys" during a sync: the page must say it was refused, not that the keys were cleared
    await page('window.confirm = () => true; 0', fubonPage())
    const [result] = await duringFubonSync(async () => {
      await page('document.getElementById("disconnect").click()', fubonPage())
      return until('document.getElementById("result").className + " " + document.getElementById("result").textContent', v => /error/.test(v), '清除被擋下的訊息', 15_000, fubonPage)
    })
    assert.match(result, /正在同步/)
    assert.equal((await page("window.broker.status('fubon')")).ok.connected, true)
    // The history key can place orders: the field is cleared as soon as it's sent, even when the import fails
    await page(`const h = document.getElementById('history'); h.elements.historyKey.value = 'no-permission-key'; h.elements.since.value = '2026-09-01'; h.requestSubmit(); 0`, fubonPage())
    assert.match(await until('document.getElementById("result").className + " " + document.getElementById("result").textContent', v => /error/.test(v), '匯入失敗的訊息', 15_000, fubonPage), /證券下單/)
    assert.equal(await page("document.getElementById('history').elements.historyKey.value", fubonPage()), '')
    fubonPage().destroy()
  })

  await test('清除金鑰、安裝 SDK：同步中會被擋下（同步結束不會把金鑰寫回來），同步完才清得掉', async () => {
    await duringFubonSync(async () => {
      assert.match((await page("window.broker.disconnect('fubon')")).error ?? '', /正在同步/)
      assert.match((await page("window.broker.installSdk('fubon')")).error ?? '', /正在同步/) // The file dialog is still the stand-in from above
    })
    assert.equal((await page("window.broker.disconnect('fubon')")).error, undefined)
    assert.equal(existsSync(join(DATA, 'fubon', 'config.json')), false)
    assert.equal((await page("window.broker.status('fubon')")).ok.connected, false)
  })

  await test('設定檔或 SDK 壞掉：券商清單照樣打得開，提示清除後重設', async () => {
    writeFileSync(join(DATA, 'fubon', 'config.json'), '{ 壞掉')
    writeFileSync(join(SDK, 'package.json'), '')
    const { ok } = await page('window.broker.list()')
    const fubon = ok.find(b => b.id === 'fubon')
    assert.match(fubon.paused, /設定檔損壞/)
    assert.equal(fubon.sdk, null) // Shows "not installed"; reinstalling fixes it
    assert.equal((await page("window.broker.disconnect('fubon')")).error, undefined)
    assert.equal((await page("window.broker.status('fubon')")).ok.connected, false)
  })

  await test('結束：視窗關掉後還進來的事件不會讓主程序出錯', async () => {
    app.on('window-all-closed', () => {}) // For the test: don't quit when the windows close, so later errors are still caught
    win().destroy()
    ipcMain.emit('solid', {}, true)
    ipcMain.emit('move', {}, 10, 10)
    ipcMain.emit('drop', {})
    screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), ['workArea'])
    app.emit('activate')
    await wait(10_500) // Wait through one 10-second refresh
  })

  await test('整個過程主程序沒有未處理的錯誤', () => {
    assert.deepEqual(crashes, [])
  })

  const failed = results.filter(ok => !ok).length
  console.log(`\n${results.length - failed} 通過，${failed} 失敗`)
  app.exit(failed ? 1 : 0)
}
