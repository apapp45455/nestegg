// 券商串接的共用流程：安裝 SDK、加密保存金鑰、同步成交紀錄、設定精靈視窗。
// 每家券商只在 brokers/<id>.js 寫自己不一樣的地方（SDK 怎麼檢查、要填哪些欄位、怎麼查成交紀錄）。
import { BrowserWindow, app, dialog, ipcMain, safeStorage, shell, utilityProcess } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { isDate } from '../engine/index.js'
import { addDays } from '../sync/fubon.js'
import fubon from './brokers/fubon.js'
import sinopac from './brokers/sinopac.js'

const BROKERS = Object.fromEntries([fubon, sinopac].map(b => [b.id, b]))
const run = promisify(execFile)
// Windows 指定系統內建的 bsdtar：PATH 上先找到 Git for Windows 的 GNU tar 會把 C:\ 當成遠端主機
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
const untar = (archive, dir) => run(TAR, ['-xf', archive, '-C', dir]) // bsdtar 能解 zip、tgz、tar.gz
let ctx, setupWin
const running = new Map() // 券商 id → { kind: 'sync' | 'install', promise }

const broker = id => BROKERS[id] ?? (() => { throw new Error(`不認識的券商：${id}`) })()
// 每家券商一個資料夾：userData/<id>/{config.json, package/}
const home = b => join(app.getPath('userData'), b.id)
const sdkDir = b => join(home(b), 'package')
const configFile = b => join(home(b), 'config.json')
const rowsFile = b => join(home(b), 'rows.json') // 快照型券商：上次同步寫進帳本的那批

const readJson = async (file, fallback) => (existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : fallback)
const writeJson = async (file, data) => {
  await writeFile(`${file}.tmp`, JSON.stringify(data, null, 2)) // 同帳本：先寫暫存檔再改名
  await rename(`${file}.tmp`, file)
}
const readConfig = b => readJson(configFile(b), null)
const writeConfig = async (b, cfg) => {
  await mkdir(home(b), { recursive: true })
  await writeJson(configFile(b), cfg)
}
const sdkVersion = b => b.sdk.version(sdkDir(b))

// 金鑰用系統鑰匙圈（macOS Keychain / Windows DPAPI）加密後才落地。
// 用非同步版：macOS 詢問鑰匙圈權限時，同步版會卡住整個主程序，寵物連拖都拖不動。
const seal = async obj => (await safeStorage.encryptStringAsync(JSON.stringify(obj))).toString('base64')
const unseal = async s => JSON.parse((await safeStorage.decryptStringAsync(Buffer.from(s, 'base64'))).result)

async function installSdk(b, file) {
  const tmp = join(home(b), 'incoming')
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  try {
    // 瀏覽器下載的檔案帶 macOS quarantine 標記，tar 解出的檔案會沿用，帶標記的原生模組一載入就卡住。
    // 用讀寫複製一份（不帶延伸屬性）再解壓縮，就不會產生標記。
    const archive = join(tmp, basename(file))
    await writeFile(archive, await readFile(file))
    await untar(archive, tmp)
    const dir = await b.sdk.unpack(tmp, untar)
    // 先把舊的移開、新的換上，再刪舊的：不會有「刪了一半」的 SDK；換不上就放回舊的
    const old = join(tmp, 'old')
    if (existsSync(sdkDir(b))) await rename(sdkDir(b), old)
    try {
      await rename(dir, sdkDir(b))
    } catch (e) {
      if (existsSync(old)) await rename(old, sdkDir(b))
      throw e
    }
    return sdkVersion(b)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}

// 在獨立的 utility process 跑券商 SDK（多半是同步呼叫，放主程序會卡住寵物）
function runWorker(file, payload, cwd) {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(file, [], { cwd, serviceName: 'NestEgg 券商同步' }) // SDK 會在 cwd 寫 log
    const timer = setTimeout(() => { child.kill(); reject(new Error('券商連線逾時，請稍後再試')) }, 120_000)
    child.once('spawn', () => child.postMessage(payload))
    child.once('message', msg => { clearTimeout(timer); child.kill(); resolve(msg) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`同步程序意外結束（代碼 ${code}）`)) })
  })
}

async function sync(b, creds, from) {
  await mkdir(home(b), { recursive: true })
  const { rows, accounts, warnings } = await b.fetch({
    creds, from, to: ctx.today(), home: home(b), sdkDir: sdkDir(b),
    runWorker: (file, payload) => runWorker(file, payload, home(b)),
  })
  if (!b.snapshot) return { added: await ctx.onRows(rows), accounts, warnings }
  // 快照型券商（只查得到目前持倉與已實現損益）每次給的是 since 起的完整紀錄：取代上次寫進帳本的那批
  // ponytail: 帳本與 rows.json 分兩次寫，剛好在中間當機會讓下次同步多出一批；要根治得把來源記進帳本
  // rows.json 讀不出來（手動改壞）就當作沒有：一樣的紀錄合併時會去重，不要因此擋住同步
  const previous = await readJson(rowsFile(b), []).catch(() => [])
  const added = await ctx.onRows(rows, previous)
  await writeJson(rowsFile(b), rows)
  return { added, accounts, warnings }
}

// 要使用者處理才會好的錯誤（登入失敗、讀不到金鑰）帶 needsUser，自動同步會因此暫停；adapter 也這樣標記
const needsUser = message => Object.assign(new Error(message), { needsUser: true })

// 同一家券商同一時間只做一件事（同步或安裝 SDK）。手動與自動同步撞在一起時共用同一次結果，不重複登入；
// 同步遇上安裝（或反過來）就擋下。不同券商可以同時同步（寫帳本由 main.js 排隊，不會互相蓋掉）
function exclusive(id, kind, fn) {
  const busy = running.get(id)
  if (busy?.kind === 'sync' && kind === 'sync') return busy.promise // 只有同步共用結果；安裝不行（第二個檔案會被默默忽略）
  idle(id)
  const promise = fn().finally(() => running.delete(id))
  running.set(id, { kind, promise })
  return promise
}
// 清除金鑰、換 SDK 不能跟那家的同步同時做：同步結束時會把讀到的舊設定寫回去，也可能載入換到一半的 SDK
function idle(id, message = '正在同步或安裝中，請等一下再試') {
  if (running.has(id)) throw new Error(message)
}

const syncSaved = id => exclusive(id, 'sync', async () => {
  const b = broker(id)
  const cfg = await readConfig(b)
  if (!cfg) throw new Error(`尚未連接${b.name}`)
  const from = addDays(cfg.lastSync, -7) // 重疊一週，補抓上次同步後才成交的紀錄（重複的會被合併掉）
  let result
  try {
    const creds = await unseal(cfg.secret).catch(e => { throw needsUser(`讀不到儲存的金鑰：${e.message}`) })
    result = await sync(b, creds, b.snapshot || from < cfg.since ? cfg.since : from)
  } catch (e) {
    // 登入失敗、讀不到金鑰這種要使用者處理的才暫停自動同步（反覆登入失敗可能讓帳號被鎖）；
    // 斷網、逾時這類暫時的問題不暫停，下個小時再試。寫不進暫停狀態也不要蓋掉原本的錯誤
    if (e.needsUser) await writeConfig(b, { ...cfg, paused: e.message }).catch(() => {})
    throw e
  }
  await writeConfig(b, { ...cfg, lastSync: ctx.today(), paused: undefined })
  return result
})

async function autoSync() {
  for (const b of Object.values(BROKERS)) {
    const cfg = await readConfig(b).catch(() => null)
    // 正在同步或安裝的跳過，下個小時再看（也避免上一輪還沒跑完時重複通知）
    if (!cfg || cfg.paused || cfg.lastSync === ctx.today() || running.has(b.id)) continue
    try {
      const { added } = await syncSaved(b.id)
      if (added) ctx.say(`${b.name}同步完成，新增 ${added} 筆紀錄`)
    } catch (e) {
      if (e.needsUser) ctx.say(`⚠️ ${b.name}同步失敗\n已暫停自動同步\n右鍵 → 證券帳戶同步…`)
      else console.error(`${b.name}同步失敗，下個小時再試：`, e.message)
    }
  }
}

async function connect(id, form) {
  const b = broker(id)
  const creds = b.credentials(form)
  const since = String(form.since ?? '')
  if (!isDate(since) || since > ctx.today()) throw new Error('請選擇今天以前的起始日期') // 2025-02-31 這種也擋下
  if (!(await sdkVersion(b))) throw new Error(`請先安裝${b.sdk.label}`)
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('這台電腦無法安全加密金鑰，因此不能儲存')
  // 不能共用正在跑的自動同步：那樣會回傳舊金鑰的結果，新輸入的金鑰也不會被存起來
  idle(id, '正在同步中，請等一下再按「連線並同步」')
  return exclusive(id, 'sync', async () => {
    const result = await sync(b, creds, since) // 先確定登入與查詢成功，才把金鑰存起來
    await writeConfig(b, { secret: await seal(creds), since, lastSync: ctx.today() })
    return result
  })
}

async function status(b) {
  // 設定檔壞掉時照樣列出來，讓使用者能清除後重設（不要讓整個券商清單打不開）
  const cfg = await readConfig(b).catch(() => ({ paused: '設定檔損壞，請按「清除儲存的金鑰」後重新連線' }))
  return { id: b.id, name: b.name, sdk: await Promise.resolve().then(() => sdkVersion(b)).catch(() => null), connected: !!cfg, since: cfg?.since, lastSync: cfg?.lastSync, paused: cfg?.paused, today: ctx.today() }
}

async function pickFile({ title, name, extensions }) {
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

export function initBrokers(context) {
  ctx = context
  handle('broker:list', () => Promise.all(Object.values(BROKERS).map(status)))
  handle('broker:status', id => status(broker(id)))
  handle('broker:install-sdk', async id => {
    const b = broker(id)
    idle(id) // 同步中就別讓人白選一次檔案
    const file = await pickFile({ title: `選擇下載的${b.sdk.label}`, name: b.sdk.label, extensions: ['zip', 'tgz', 'gz'] })
    return file && exclusive(id, 'install', () => installSdk(b, file))
  })
  handle('broker:pick-cert', id => pickFile(broker(id).cert))
  handle('broker:connect', connect)
  handle('broker:sync', syncSaved)
  handle('broker:disconnect', id => {
    idle(id)
    return rm(configFile(broker(id)), { force: true })
  })
  setTimeout(autoSync, 5_000)
  setInterval(autoSync, 3_600_000) // 每小時看一次今天同步了沒
}

export function openSetup() {
  if (setupWin && !setupWin.isDestroyed()) return setupWin.focus()
  setupWin = new BrowserWindow({
    width: 640,
    height: 760,
    title: '連接證券帳戶',
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
