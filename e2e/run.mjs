// 端到端測試：真的啟動 NestEgg（主程序、寵物視窗、富邦同步的 utility process），
// 用暫存資料夾、假富邦 SDK 與預先放好的行情快取，不連網、不碰你的真實資料。
// 執行：npm run test:e2e（macOS 與 Windows 都能跑，CI 也跑這支）
import { app, BrowserWindow, ipcMain, screen } from 'electron'
import assert from 'node:assert/strict'
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

// 整個過程中只要主程序丟出未處理的錯誤就算失敗（使用者看到的就是「JavaScript error」對話框）
const crashes = []
process.on('uncaughtException', e => crashes.push(e.message))
process.on('unhandledRejection', e => crashes.push(String(e?.message ?? e)))
setTimeout(() => { console.error('✖ 逾時'); app.exit(1) }, 120_000)

await import('../app/main.js')
// 注意：ESM 入口不能在最上層 await app.whenReady()（ready 要等入口跑完才會觸發），所以包成函式
app.whenReady().then(runAll)

const wait = ms => new Promise(r => setTimeout(r, ms))
const win = () => BrowserWindow.getAllWindows().find(w => !w.isDestroyed()) // 測試不開設定精靈，唯一的視窗就是寵物
const page = code => win().webContents.executeJavaScript(code)
async function until(code, ok, label, ms = 15_000) {
  for (const end = Date.now() + ms; Date.now() < end; await wait(200)) {
    const v = await Promise.resolve().then(() => page(code)).catch(() => undefined)
    if (ok(v)) return v
  }
  throw new Error(`等不到：${label}`)
}
const ledgerLines = () => {
  const f = join(DATA, 'ledger.csv')
  return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').length - 1 : 0
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
    const status = await page('window.fubon.status()')
    assert.equal(status.ok.sdk, '2.4.0-fake')
    const res = await page(`window.fubon.connect({ id: 'a123456789', apiKey: 'e2e-key', certPath: ${JSON.stringify(CERT)}, certPass: '', since: '2025-10-01' })`)
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

  await test('富邦同步：再同步一次不會重複', async () => {
    const res = await page('window.fubon.sync()')
    assert.equal(res.ok.added, 0)
    assert.equal(ledgerLines(), 11)
  })

  await test('富邦同步：同步中按「連線並同步」會被擋下，不會拿到舊結果、也不會蓋掉儲存的金鑰', async () => {
    const secret = () => JSON.parse(readFileSync(join(DATA, 'fubon', 'config.json'), 'utf8')).secret
    const before = secret()
    writeFileSync(join(SDK, 'slow-login'), '')
    try {
      const syncing = page('window.fubon.sync()') // 先送出，主程序收到就標記為同步中
      const res = await page(`window.fubon.connect({ id: 'b123456789', apiKey: 'other-key', certPath: ${JSON.stringify(CERT)}, certPass: '', since: '2025-10-01' })`)
      assert.match(res.error ?? '', /正在同步中/)
      assert.equal((await syncing).ok?.added, 0)
    } finally {
      rmSync(join(SDK, 'slow-login'))
    }
    assert.equal(secret(), before)
  })

  await test('富邦同步：登入失敗時暫停自動同步、帳本不變', async () => {
    writeFileSync(join(SDK, 'fail-login'), '')
    const res = await page('window.fubon.sync()')
    assert.match(res.error, /登入失敗/)
    assert.match((await page('window.fubon.status()')).ok.paused, /登入失敗/)
    assert.equal(ledgerLines(), 11)
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
