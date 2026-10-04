// 端到端測試：真的啟動 NestEgg（主程序、寵物視窗、富邦同步的 utility process），
// 用暫存資料夾、假富邦 SDK、假 Shioaji 伺服器與預先放好的行情快取，不連網、不碰你的真實資料。
// 執行：npm run test:e2e（macOS 與 Windows 都能跑，CI 也跑這支）
import { app, BrowserWindow, dialog, ipcMain, screen } from 'electron'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const DATA = mkdtempSync(join(tmpdir(), 'nestegg-e2e-'))
const SDK = join(DATA, 'fubon', 'package')
app.setPath('userData', DATA)

// 行情快取：剛抓的，所以 app 不會連網；0050 收 112、漲 2（前一天 110）
writeFileSync(join(DATA, 'market.json'), JSON.stringify({
  date: '2026-10-02', indexChange: 1.2, prices: { '0050': { close: 112, change: 2 } }, fetchedAt: Date.now(),
}))
// 假富邦 SDK 直接放到「已安裝」的位置（安裝流程要開檔案對話框，交給手動測試）
mkdirSync(SDK, { recursive: true })
cpSync(join(import.meta.dirname, 'fake-fubon-sdk'), SDK, { recursive: true })
const CERT = join(DATA, 'test-cert.pfx')
writeFileSync(CERT, 'not a real certificate')
// 永豐：假裝 Shioaji 命令列程式已經裝好；真正開伺服器的那一步換成下面的假伺服器
const SHIOAJI = join(DATA, 'sinopac', 'package')
mkdirSync(SHIOAJI, { recursive: true })
writeFileSync(join(SHIOAJI, process.platform === 'win32' ? 'shioaji.exe' : 'shioaji'), '')
writeFileSync(join(SHIOAJI, 'version.txt'), '1.7.7-fake')

// 假的 Shioaji 本機 API 伺服器：回應帳務查詢，並記下被呼叫了哪些路徑
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
    res.writeHead(reply ? 200 : 404, { 'Content-Type': 'application/json' }).end(JSON.stringify(reply ?? { message: 'not found' }))
  })
}).listen(0, '127.0.0.1')

// 整個過程中只要主程序丟出未處理的錯誤就算失敗（使用者看到的就是「JavaScript error」對話框）
const crashes = []
process.on('uncaughtException', e => crashes.push(e.message))
process.on('unhandledRejection', e => crashes.push(String(e?.message ?? e)))
setTimeout(() => { console.error('✖ 逾時'); app.exit(1) }, 120_000)

await import('../app/main.js')
const { openSetup, syncSaved } = await import('../app/brokers.js') // syncSaved 直接呼叫＝自動同步那條路
const { default: sinopac } = await import('../app/brokers/sinopac.js')
let shioajiStops = 0
sinopac.server = async (bin, creds) => {
  shioaji.started = { bin, creds }
  return { url: `http://127.0.0.1:${fakeShioaji.address().port}`, stop: () => shioajiStops++ }
}
// 注意：ESM 入口不能在最上層 await app.whenReady()（ready 要等入口跑完才會觸發），所以包成函式
app.whenReady().then(runAll)

const wait = ms => new Promise(r => setTimeout(r, ms))
const windowAt = file => BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && w.webContents.getURL().endsWith(file))
const win = () => windowAt('/index.html') // 寵物
const page = (code, w = win()) => w.webContents.executeJavaScript(code)
async function until(code, ok, label, ms = 15_000, w = win) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(200)) {
    const v = await Promise.resolve().then(() => page(code, w())).catch(() => undefined)
    if (ok(v)) return v
  }
  throw new Error(`等不到：${label}`)
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

  await test('富邦同步：用假 SDK 連線，只算現股、寫進帳本、寵物孵化', async () => {
    const status = await page("window.broker.status('fubon')")
    assert.equal(status.ok.sdk, '2.4.0-fake')
    const badDate = await page(`window.broker.connect('fubon', { id: 'a123456789', apiKey: 'e2e-key', certPath: ${JSON.stringify(CERT)}, since: '2025-02-31' })`)
    assert.match(badDate.error, /起始日期/) // 不存在的日期，不是一句看不懂的 RangeError
    const res = await page(`window.broker.connect('fubon', { id: 'a123456789', apiKey: 'e2e-key', certPath: ${JSON.stringify(CERT)}, certPass: '', since: '2025-10-01' })`)
    assert.equal(res.error, undefined, res.error)
    assert.equal(res.ok.added, 11) // 12 筆成交，融資那筆不算
    assert.equal(res.ok.accounts, 1) // 期貨帳戶不查
    assert.equal(ledgerLines(), 11)
    await until('state.stage', v => v === 'baby' || v === 'adult', '孵化')
  })

  await test('富邦同步：金鑰加密保存，設定檔裡找不到明文', async () => {
    const cfg = readFileSync(join(DATA, 'fubon', 'config.json'), 'utf8')
    assert.doesNotMatch(cfg, /A123456789|e2e-key/)
    assert.match(JSON.parse(cfg).secret, /^[A-Za-z0-9+/=]{20,}$/)
  })

  await test('富邦同步：再同步一次不會重複；登出失敗也不影響查到的紀錄', async () => {
    writeFileSync(join(SDK, 'fail-logout'), '')
    try {
      const res = await page("window.broker.sync('fubon')")
      assert.equal(res.error, undefined, res.error)
      assert.equal(res.ok.added, 0)
    } finally {
      rmSync(join(SDK, 'fail-logout'))
    }
    assert.equal(ledgerLines(), 11)
  })

  await test('富邦同步：同步中按「連線並同步」會被擋下，不會拿到舊結果、也不會蓋掉儲存的金鑰', async () => {
    const secret = () => JSON.parse(readFileSync(join(DATA, 'fubon', 'config.json'), 'utf8')).secret
    const before = secret()
    writeFileSync(join(SDK, 'slow-login'), '')
    try {
      const syncing = page("window.broker.sync('fubon')") // 先送出，主程序收到就標記為同步中
      const res = await page(`window.broker.connect('fubon', { id: 'b123456789', apiKey: 'other-key', certPath: ${JSON.stringify(CERT)}, certPass: '', since: '2025-10-01' })`)
      assert.match(res.error ?? '', /正在同步中/)
      assert.equal((await syncing).ok?.added, 0)
    } finally {
      rmSync(join(SDK, 'slow-login'))
    }
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
    // 2890 分兩次各買 1000 股（明細以張計），2330 是融資不算
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
    assert.equal(shioajiStops, 1) // 查完就關掉伺服器
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
    assert.equal(res.ok.added, 2) // 新的賣出與帶手續費的買進；沒變的那筆不算（以前會算成淨增 1 筆）
    assert.equal(ledgerLines(',2890,'), 3)
    assert.equal(ledgerLines('2026-04-01,2890,buy,1000,30000,42'), 1)
    assert.equal(ledgerLines('2026-04-15,2890,buy,1000,30000,0'), 1)
    assert.equal(ledgerLines('2026-06-01,2890,sell,1000,35000,0'), 1)
  })

  await test('兩家券商同時同步：各自拿到自己的結果，帳本兩邊的紀錄都在', async () => {
    rmSync(join(SDK, 'fail-login'))
    writeFileSync(join(SDK, 'slow-login'), '') // 富邦卡 2 秒，永豐趁這時候同步
    shioaji.positions.push({ id: 1, code: '2884', direction: 'Buy', quantity: 1000, price: 30, cond: 'Cash' })
    shioaji.positionDetails[1] = [{ date: '2026-07-01', quantity: 1 }]
    try {
      const fubon = page("window.broker.sync('fubon')")
      const sinopacRes = await page("window.broker.sync('sinopac')")
      assert.equal(sinopacRes.error, undefined, sinopacRes.error)
      assert.equal(sinopacRes.ok.added, 1) // 不是富邦那次的結果
      const fubonRes = await fubon
      assert.equal(fubonRes.error, undefined, fubonRes.error)
      assert.equal(fubonRes.ok.added, 0)
    } finally {
      rmSync(join(SDK, 'slow-login'))
      writeFileSync(join(SDK, 'fail-login'), '') // 恢復前面測試的狀態
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
      const res = await page("window.broker.sync('sinopac')") // 使用者按「立即同步」＝確認
      assert.equal(res.error, undefined, res.error)
      assert.equal(ledgerLines(',2890,') + ledgerLines(',2884,'), 0)
    } finally {
      Object.assign(shioaji, { positions, profitLoss })
    }
    assert.equal((await page("window.broker.sync('sinopac')")).error, undefined) // 資料回來，給後面的測試用
    assert.equal(ledgerLines(',2890,'), 3)
    assert.equal(ledgerLines(',2884,'), 1)
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

  await test('行情：天氣、心情、毛色跟著快取的行情走', async () => {
    // 成本每股約 69，收盤 112 → 毛色發亮；漲 2/110 ≈ +1.8% → 開心；加權 +1.2% → 晴天
    const s = await until('state', v => v?.weather, '行情狀態')
    assert.deepEqual([s.weather, s.mood, s.fur], ['sunny', 'happy', 'shiny'])
    assert.equal(await page('sky.hidden'), false)
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
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] }) // 代替檔案對話框
      return page("window.broker.installSdk('fubon')")
    }
    assert.match((await install(pack('other', { name: 'other-sdk', version: '9.9.9' }))).error, /不是富邦/)
    assert.match((await install(pack('old', { name: 'fubon-neo', version: '2.0.0' }))).error, /太舊/)
    assert.equal((await page("window.broker.status('fubon')")).ok.sdk, '2.4.0-fake')
    rmSync(join(SDK, 'fail-login')) // 換上的新版不帶舊資料夾裡的檔案
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
    assert.match(list, /自動同步已暫停/) // 永豐：前面測試的模擬環境錯誤
    await page('document.querySelector(".brokers a").click()', setup())
    const fubonPage = () => windowAt('/setup-fubon.html')
    assert.match(await until('document.getElementById("sdk-status").textContent', v => v, 'SDK 狀態', 15_000, fubonPage), /已安裝 v2\.5\.0-fake/)
    // 同步中按「清除儲存的金鑰」：畫面要說被擋下，不能說已清除
    await page('window.confirm = () => true; 0', fubonPage())
    writeFileSync(join(SDK, 'slow-login'), '')
    try {
      const syncing = page("window.broker.sync('fubon')")
      await page('document.getElementById("disconnect").click()', fubonPage())
      const result = await until('document.getElementById("result").className + " " + document.getElementById("result").textContent', v => /error/.test(v), '清除被擋下的訊息', 15_000, fubonPage)
      assert.match(result, /正在同步/)
      await syncing
    } finally {
      rmSync(join(SDK, 'slow-login'))
    }
    assert.equal((await page("window.broker.status('fubon')")).ok.connected, true)
    fubonPage().destroy()
  })

  await test('清除金鑰、安裝 SDK：同步中會被擋下（同步結束不會把金鑰寫回來），同步完才清得掉', async () => {
    writeFileSync(join(SDK, 'slow-login'), '')
    try {
      const syncing = page("window.broker.sync('fubon')")
      assert.match((await page("window.broker.disconnect('fubon')")).error ?? '', /正在同步/)
      assert.match((await page("window.broker.installSdk('fubon')")).error ?? '', /正在同步/) // 檔案對話框還是上面那個替身
      await syncing
    } finally {
      rmSync(join(SDK, 'slow-login'))
    }
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
    assert.equal(fubon.sdk, null) // 顯示「尚未安裝」，重新安裝就好
    assert.equal((await page("window.broker.disconnect('fubon')")).error, undefined)
    assert.equal((await page("window.broker.status('fubon')")).ok.connected, false)
  })

  await test('結束：視窗關掉後還進來的事件不會讓主程序出錯', async () => {
    app.on('window-all-closed', () => {}) // 測試用：視窗關了先別結束，才看得到之後的錯誤
    win().destroy()
    ipcMain.emit('solid', {}, true)
    ipcMain.emit('move', {}, 10, 10)
    ipcMain.emit('drop', {})
    screen.emit('display-metrics-changed', {}, screen.getPrimaryDisplay(), ['workArea'])
    app.emit('activate')
    await wait(10_500) // 等過一次每 10 秒的重新整理
  })

  await test('整個過程主程序沒有未處理的錯誤', () => {
    assert.deepEqual(crashes, [])
  })

  const failed = results.filter(ok => !ok).length
  console.log(`\n${results.length - failed} 通過，${failed} 失敗`)
  app.exit(failed ? 1 : 0)
}
