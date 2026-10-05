// Shared broker flow: SDK install, encrypted key storage, trade sync and the setup wizard window.
// Each broker only implements what differs in brokers/<id>.js (SDK checks, form fields, how to query trades).
import { BrowserWindow, app, dialog, ipcMain, safeStorage, shell, utilityProcess } from 'electron'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { addDays, isDate } from '../engine/index.js'
import fubon from './brokers/fubon.js'
import sinopac from './brokers/sinopac.js'

const BROKERS = Object.fromEntries([fubon, sinopac].map(b => [b.id, b]))
const run = promisify(execFile)
// On Windows use the built-in bsdtar: Git for Windows' GNU tar, if found first on PATH, treats C:\ as a remote host
const TAR = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
const untar = (archive, dir) => run(TAR, ['-xf', archive, '-C', dir]) // bsdtar handles zip, tgz and tar.gz
let ctx, setupWin
const running = new Map() // broker id → { kind: 'sync' | 'install', promise }

const broker = id => BROKERS[id] ?? (() => { throw new Error(`不認識的券商：${id}`) })()
// One folder per broker: userData/<id>/{config.json, package/}
const home = b => join(app.getPath('userData'), b.id)
const sdkDir = b => join(home(b), 'package')
const configFile = b => join(home(b), 'config.json')
const rowsFile = b => join(home(b), 'rows.json') // Snapshot brokers: the batch the last sync wrote to the ledger

const readJson = async (file, fallback) => (existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : fallback)
const writeJson = async (file, data) => {
  await writeFile(`${file}.tmp`, JSON.stringify(data, null, 2)) // Same as the ledger: write a temp file, then rename
  await rename(`${file}.tmp`, file)
}
const readConfig = b => readJson(configFile(b), null)
const writeConfig = async (b, cfg) => {
  await mkdir(home(b), { recursive: true })
  await writeJson(configFile(b), cfg)
}
const sdkVersion = b => b.sdk.version(sdkDir(b))

// Keys are encrypted with the system keychain (macOS Keychain / Windows DPAPI) before touching disk.
// Use the async API: while macOS asks for keychain access, the sync API blocks the whole main process and the pet can't even be dragged.
const seal = async obj => (await safeStorage.encryptStringAsync(JSON.stringify(obj))).toString('base64')
const unseal = async s => JSON.parse((await safeStorage.decryptStringAsync(Buffer.from(s, 'base64'))).result)

async function installSdk(b, file) {
  const tmp = join(home(b), 'incoming')
  await rm(tmp, { recursive: true, force: true })
  await mkdir(tmp, { recursive: true })
  try {
    // Browser downloads carry the macOS quarantine flag, tar passes it on to extracted files, and a flagged native module hangs on load.
    // Copying by read/write (without extended attributes) before extracting avoids the flag.
    const archive = join(tmp, basename(file))
    await writeFile(archive, await readFile(file))
    await untar(archive, tmp)
    const dir = await b.sdk.unpack(tmp, untar)
    // Move the old SDK aside, put the new one in place, then delete the old one: never a half-deleted SDK, and the old one is restored if the swap fails
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

// Run the broker SDK in a separate utility process (most calls are synchronous and would freeze the pet in the main process)
function runWorker(file, payload, cwd) {
  return new Promise((resolve, reject) => {
    const child = utilityProcess.fork(file, [], { cwd, serviceName: 'NestEgg 券商同步' }) // The SDK writes logs to cwd
    const timer = setTimeout(() => { child.kill(); reject(new Error('券商連線逾時，請稍後再試')) }, 120_000)
    child.once('spawn', () => child.postMessage(payload))
    child.once('message', msg => { clearTimeout(timer); child.kill(); resolve(msg) })
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`同步程序意外結束（代碼 ${code}）`)) })
  })
}

// manual: started by the user (connect, sync now); counts as confirmation when a snapshot comes back empty
async function sync(b, creds, from, manual = false) {
  await mkdir(home(b), { recursive: true })
  const { rows: fresh, accounts, warnings, skipped = [] } = await b.fetch({
    creds, from, to: ctx.today(), home: home(b), sdkDir: sdkDir(b),
    runWorker: (file, payload) => runWorker(file, payload, home(b)),
  }).catch(e => {
    // The stack also carries the original message (failed auto syncs console.error the whole error); rethrow non-Errors untouched so masking never throws a new error
    if (e instanceof Error) Object.assign(e, { message: redact(e.message, Object.values(creds)), stack: e.stack && redact(e.stack, Object.values(creds)) })
    throw e
  })
  if (!b.snapshot) return { added: (await ctx.onRows(fresh)).added, accounts, warnings }
  // Snapshot brokers (only current positions and realized P&L are available) return the full history since `since` every time: replace the batch the last sync wrote.
  // If rows.json can't be read, stop and leave the ledger alone: snapshot numbers change, and guessing the previous batch wrong would double-count principal
  const previous = await readJson(rowsFile(b), []).catch(() => {
    throw needsUser(`${b.name}的同步紀錄檔損壞，為了不重複記帳先停止同步。請刪除 NestEgg 資料夾裡的 ${b.id}/rows.json，再檢查帳本有沒有重複的紀錄`)
  })
  // Stocks with incomplete data this time (reported in `skipped`): keep the previous batch instead, so missing data doesn't make buys vanish from the ledger
  const rows = [...fresh.filter(r => !skipped.includes(r.symbol)), ...previous.filter(r => skipped.includes(r.symbol))]
  // Nothing came back this time but something did last time: the broker may be returning empty data (maintenance), or everything was really sold. Auto sync doesn't guess; it stops and asks the user to confirm
  if (!rows.length && previous.length && !manual) {
    throw needsUser(`${b.name}這次沒有回傳任何持倉或損益，先不更新帳本。如果你已經全部賣出，請按「立即同步」確認`)
  }
  // Record both the old and new batches before writing the ledger: after a crash mid-write, or if the next step fails, the next sync removes both first and leaves no duplicates
  await writeJson(rowsFile(b), [...previous, ...rows])
  const { added, inserted } = await ctx.onRows(rows, previous)
  await writeJson(rowsFile(b), inserted) // Only record rows this sync actually inserted; identical rows the user entered themselves don't belong to the sync
  return { added, accounts, warnings }
}

// Broker error messages can leak keys (Shioaji prints the whole API key when it doesn't exist, plus its first 10 characters in the request ID).
// Error messages are shown on screen and saved as the pause reason in the config file, so mask whole keys and fragments of 8+ characters; fields shorter than 8 characters (certificate passwords) are skipped so ordinary words aren't masked
const redact = (text, secrets) => secrets.filter(s => typeof s === 'string' && s.length >= 8).reduce(
  (t, s) => t.replaceAll(s, '***').replace(/[A-Za-z0-9]{8,}/g, w => (s.includes(w) ? '***' : w)), text)

// Errors only the user can fix (login failure, unreadable keys) carry needsUser, which pauses auto sync; adapters mark errors the same way
const needsUser = message => Object.assign(new Error(message), { needsUser: true })

// One thing at a time per broker (sync or SDK install). A manual sync that collides with an auto sync shares its result instead of logging in twice;
// a sync during an install (or the reverse) is refused. Different brokers can sync at the same time (main.js queues ledger writes, so they never overwrite each other)
function exclusive(id, kind, fn) {
  const busy = running.get(id)
  if (busy?.kind === 'sync' && kind === 'sync') return busy.promise // Only syncs share results; installs can't (the second file would be silently ignored)
  idle(id)
  const promise = fn().finally(() => running.delete(id))
  running.set(id, { kind, promise })
  return promise
}
// Clearing keys or swapping the SDK can't run during that broker's sync: the sync writes back the old config it read, and could load a half-swapped SDK
function idle(id, message = '正在同步或安裝中，請等一下再試') {
  if (running.has(id)) throw new Error(message)
}

export const syncSaved = (id, manual = false) => exclusive(id, 'sync', async () => {
  const b = broker(id)
  const cfg = await readConfig(b)
  if (!cfg) throw new Error(`尚未連接${b.name}`)
  const from = addDays(cfg.lastSync, -7) // Overlap by a week to catch trades settled after the last sync (duplicates are merged)
  let result
  try {
    const creds = await unseal(cfg.secret).catch(e => { throw needsUser(`讀不到儲存的金鑰：${e.message}`) })
    result = await sync(b, creds, b.snapshot || from < cfg.since ? cfg.since : from, manual)
  } catch (e) {
    // Only pause auto sync for errors the user must fix, such as login failure or unreadable keys (repeated failed logins can lock the account);
    // temporary problems like network errors or timeouts don't pause it; it retries next hour. Failing to save the pause must not hide the original error
    if (e.needsUser) await writeConfig(b, { ...cfg, paused: e.message }).catch(() => {})
    throw e
  }
  await writeConfig(b, { ...cfg, lastSync: ctx.today(), paused: undefined })
  return result
})

async function autoSync() {
  for (const b of Object.values(BROKERS)) {
    const cfg = await readConfig(b).catch(() => null)
    // Skip brokers that are syncing or installing and check again next hour (also avoids duplicate notices while the previous round is still running)
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
  if (!isDate(since) || since > ctx.today()) throw new Error('請選擇今天以前的起始日期') // Also rejects dates like 2025-02-31
  if (!(await sdkVersion(b))) throw new Error(`請先安裝${b.sdk.label}`)
  if (!(await safeStorage.isAsyncEncryptionAvailable())) throw new Error('這台電腦無法安全加密金鑰，因此不能儲存')
  // Can't share a running auto sync: it would return results for the old keys, and the newly entered keys would never be saved
  idle(id, '正在同步中，請等一下再按「連線並同步」')
  return exclusive(id, 'sync', async () => {
    const result = await sync(b, creds, since, true) // Only save the keys after login and the query succeed
    await writeConfig(b, { secret: await seal(creds), since, lastSync: ctx.today() })
    return result
  })
}

async function status(b) {
  // List the broker even if its config is corrupt, so the user can clear it and set it up again (don't break the whole broker list)
  const cfg = await readConfig(b).catch(() => ({ paused: '設定檔損壞，請按「清除儲存的金鑰」後重新連線' }))
  return { id: b.id, name: b.name, sdk: await Promise.resolve().then(() => sdkVersion(b)).catch(() => null), connected: !!cfg, since: cfg?.since, lastSync: cfg?.lastSync, paused: cfg?.paused, today: ctx.today() }
}

async function pickFile({ title, name, extensions }) {
  const { canceled, filePaths } = await dialog.showOpenDialog(setupWin, { title, filters: [{ name, extensions }], properties: ['openFile'] })
  return canceled ? null : filePaths[0]
}

// Return { ok } or { error } so the renderer gets a clean error message
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
    idle(id) // Don't make the user pick a file for nothing while a sync is running
    const file = await pickFile({ title: `選擇下載的${b.sdk.label}`, name: b.sdk.label, extensions: ['zip', 'tgz', 'gz'] })
    return file && exclusive(id, 'install', () => installSdk(b, file))
  })
  handle('broker:pick-cert', id => pickFile(broker(id).cert))
  handle('broker:connect', connect)
  handle('broker:sync', id => syncSaved(id, true))
  handle('broker:disconnect', id => {
    idle(id)
    return rm(configFile(broker(id)), { force: true })
  })
  setTimeout(autoSync, 5_000)
  setInterval(autoSync, 3_600_000) // Check every hour whether today's sync has run
}

export function openSetup() {
  if (setupWin && !setupWin.isDestroyed()) return setupWin.focus()
  setupWin = new BrowserWindow({
    width: 640,
    height: 760,
    title: '連接證券帳戶',
    webPreferences: { preload: join(import.meta.dirname, 'preload.cjs') },
  })
  // Open links from the instructions in the default browser
  setupWin.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url)
    return { action: 'deny' }
  })
  setupWin.loadFile(join(import.meta.dirname, 'setup.html'))
  app.focus({ steal: true })
}
