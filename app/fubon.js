// 富邦證券串接：安裝 SDK、加密保存金鑰、同步成交紀錄、設定精靈視窗
import { BrowserWindow, app, dialog, ipcMain, safeStorage, shell, utilityProcess } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { addDays, dateWindows, fillsToRows } from '../sync/fubon.js'

const HOME = join(app.getPath('userData'), 'fubon')
const SDK_DIR = join(HOME, 'package')
const CONFIG = join(HOME, 'config.json')
const MIN_SDK = '2.2.7' // apikeyLogin 從這版開始
const run = promisify(execFile)
let ctx, setupWin, running = null

const readConfig = async () => (existsSync(CONFIG) ? JSON.parse(await readFile(CONFIG, 'utf8')) : null)
const writeConfig = async cfg => {
  await writeFile(`${CONFIG}.tmp`, JSON.stringify(cfg, null, 2)) // 同帳本：先寫暫存檔再改名
  await rename(`${CONFIG}.tmp`, CONFIG)
}
const sdkVersion = async () =>
  existsSync(join(SDK_DIR, 'trade.js')) ? JSON.parse(await readFile(join(SDK_DIR, 'package.json'), 'utf8')).version : null

// 金鑰用系統鑰匙圈（macOS Keychain / Windows DPAPI）加密後才落地。
// 用非同步版：macOS 詢問鑰匙圈權限時，同步版會卡住整個主程序，寵物連拖都拖不動。
const seal = async obj => (await safeStorage.encryptStringAsync(JSON.stringify(obj))).toString('base64')
const unseal = async s => JSON.parse((await safeStorage.decryptStringAsync(Buffer.from(s, 'base64'))).result)

async function installSdk(file) {
  const tmp = join(HOME, 'incoming')
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  try {
    // 瀏覽器下載的檔案帶 macOS quarantine 標記，tar 解出的檔案會沿用，帶標記的原生模組一載入就卡住。
    // 用讀寫複製一份（不帶延伸屬性）再解壓縮，就不會產生標記。
    const archive = join(tmp, basename(file))
    await writeFile(archive, await readFile(file))
    // macOS 與 Windows 10+ 內建的 tar（bsdtar）都能解 zip 與 tgz
    let tgz = archive
    if (/\.zip$/i.test(file)) {
      await run('tar', ['-xf', archive, '-C', tmp])
      const name = (await readdir(tmp)).find(f => f.endsWith('.tgz'))
      if (!name) throw new Error('zip 裡找不到 .tgz 檔')
      tgz = join(tmp, name)
    }
    await run('tar', ['-xzf', tgz, '-C', tmp])
    const pkgFile = join(tmp, 'package', 'package.json')
    const pkg = existsSync(pkgFile) ? JSON.parse(await readFile(pkgFile, 'utf8')) : {}
    if (pkg.name !== 'fubon-neo' || !existsSync(join(tmp, 'package', 'trade.js'))) {
      throw new Error('這不是富邦新一代 API 的 Node.js SDK')
    }
    if (pkg.version.localeCompare(MIN_SDK, undefined, { numeric: true }) < 0) {
      throw new Error(`SDK 版本 ${pkg.version} 太舊，需要 ${MIN_SDK} 以上`)
    }
    await rm(SDK_DIR, { recursive: true, force: true })
    await rename(join(tmp, 'package'), SDK_DIR)
    return pkg.version
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

function runWorker(payload) {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(join(import.meta.dirname, 'fubon-worker.cjs'), [], { cwd: HOME, serviceName: 'NestEgg 富邦同步' })
    const timer = setTimeout(() => { child.kill(); reject(new Error('富邦連線逾時，請稍後再試')) }, 120_000)
    child.once('spawn', () => child.postMessage(payload))
    child.once('message', msg => { clearTimeout(timer); child.kill(); resolve(msg) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`同步程序意外結束（代碼 ${code}）`)) })
  })
}

async function sync(creds, from) {
  const res = await runWorker({ sdkDir: SDK_DIR, ...creds, windows: dateWindows(from, ctx.today()) })
  if (/連線測試成功/.test(res.error ?? '')) throw new Error('富邦回覆連線測試成功，API 權限會在簽署隔天 9:00 前開通，到時候再按一次「連線並同步」。')
  if (res.error) throw new Error(res.error)
  if (!res.fills.length && res.errors.length) throw new Error(`查詢成交紀錄失敗：${res.errors[0]}`)
  const added = await ctx.onRows(fillsToRows(res.fills))
  return { added, accounts: res.accounts, warnings: res.errors }
}

// 同一時間只跑一個同步，避免手動與自動同步重複登入
const exclusive = fn => (running ??= fn().finally(() => (running = null)))

const syncSaved = () => exclusive(async () => {
  const cfg = await readConfig()
  if (!cfg) throw new Error('尚未連接富邦帳戶')
  const from = addDays(cfg.lastSync, -7) // 重疊一週，補抓上次同步後才成交的紀錄（重複的會被合併掉）
  try {
    const result = await sync(await unseal(cfg.secret), from < cfg.since ? cfg.since : from)
    await writeConfig({ ...cfg, lastSync: ctx.today(), paused: undefined })
    return result
  } catch (e) {
    await writeConfig({ ...cfg, paused: e.message }) // 暫停自動同步：反覆登入失敗可能讓帳號被鎖
    throw e
  }
})

async function autoSync() {
  const cfg = await readConfig().catch(() => null)
  if (!cfg || cfg.paused || cfg.lastSync === ctx.today()) return
  try {
    const { added } = await syncSaved()
    if (added) ctx.say(`富邦同步完成，新增 ${added} 筆紀錄`)
  } catch {
    ctx.say('⚠️ 富邦同步失敗\n已暫停自動同步\n右鍵 → 富邦證券同步…')
  }
}

async function connect(form) {
  const creds = {
    id: String(form.id ?? '').trim().toUpperCase(),
    apiKey: String(form.apiKey ?? '').trim(),
    certPath: String(form.certPath ?? ''),
    certPass: String(form.certPass ?? ''),
  }
  const since = String(form.since ?? '')
  if (!creds.id || !creds.apiKey || !creds.certPath) throw new Error('請填寫身分證字號、API Key，並選擇憑證檔')
  if (!existsSync(creds.certPath)) throw new Error('找不到憑證檔，請重新選擇')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(since) || since > ctx.today()) throw new Error('請選擇今天以前的起始日期')
  if (!(await sdkVersion())) throw new Error('請先完成步驟 3：安裝 SDK')
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('這台電腦無法安全加密金鑰，因此不能儲存')
  return exclusive(async () => {
    const result = await sync(creds, since) // 先確定登入與查詢成功，才把金鑰存起來
    await writeConfig({ secret: await seal(creds), since, lastSync: ctx.today() })
    return result
  })
}

async function pickFile(title, name, extensions) {
  const { canceled, filePaths } = await dialog.showOpenDialog(setupWin, { title, filters: [{ name, extensions }], properties: ['openFile'] })
  return canceled ? null : filePaths[0]
}

// 回傳 { ok } 或 { error }，renderer 才拿得到乾淨的錯誤訊息
const handle = (channel, fn) => ipcMain.handle(channel, async (_e, ...args) => {
  try {
    return { ok: await fn(...args) }
  } catch (e) {
    return { error: e.message }
  }
})

export function initFubon(context) {
  ctx = context
  handle('fubon:status', async () => {
    const cfg = await readConfig()
    return { sdk: await sdkVersion(), connected: !!cfg, since: cfg?.since, lastSync: cfg?.lastSync, paused: cfg?.paused, today: ctx.today() }
  })
  handle('fubon:install-sdk', async () => {
    const file = await pickFile('選擇下載的富邦 Node.js SDK', '富邦 SDK', ['zip', 'tgz'])
    return file && installSdk(file)
  })
  handle('fubon:pick-cert', () => pickFile('選擇富邦憑證', '憑證', ['pfx', 'p12']))
  handle('fubon:connect', connect)
  handle('fubon:sync', syncSaved)
  handle('fubon:disconnect', () => rm(CONFIG, { force: true }))
  setTimeout(autoSync, 5_000)
  setInterval(autoSync, 3_600_000) // 每小時看一次今天同步了沒
}

export function openSetup() {
  if (setupWin && !setupWin.isDestroyed()) return setupWin.focus()
  setupWin = new BrowserWindow({
    width: 640,
    height: 760,
    title: '連接富邦證券',
    webPreferences: { preload: join(import.meta.dirname, 'preload.cjs') },
  })
  // 說明裡的連結用預設瀏覽器開
  setupWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  setupWin.loadFile(join(import.meta.dirname, 'setup.html'))
  app.focus({ steal: true })
}
