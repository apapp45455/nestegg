import { app, BrowserWindow, Menu, dialog, ipcMain, screen, shell } from 'electron'
import { existsSync } from 'node:fs'
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HEADER, SETTINGS, evaluate, mergeLedger, parseLedger, parsePlans, parseSettings, planRows, removeRows, toCsv } from '../engine/index.js'
import { initBrokers, openSetup } from './brokers.js'
import { getMarket, startMarket } from './market.js'
import { anchorOf, placeAt } from './placement.js'

const W = 200, H = 300
const LEDGER = join(app.getPath('userData'), 'ledger.csv')
const SETTINGS_FILE = join(app.getPath('userData'), 'settings.json')
const PLANS_FILE = join(app.getPath('userData'), 'plans.json')
let win, settingsWin, plansWin
// On quit the window is destroyed first, while timers, mouse events and display changes can still arrive, so always get the window through here
const pet = () => (win && !win.isDestroyed() ? win : null)
let anchor = { right: 40, bottom: 0 } // Which corner the pet sticks to and how far from it; bottom-right by default

// When the display, resolution or Dock size changes, re-place the pet at the same corner and distance so it never ends up off screen
function place() {
  const w = pet()
  if (!w) return
  const { workArea } = screen.getDisplayMatching(w.getBounds())
  w.setBounds(placeAt(anchor, workArea, { width: W, height: H }))
}

// Local date as YYYY-MM-DD (toISOString is UTC, which is a day behind in Taiwan before 8 a.m.)
const today = () => {
  const d = new Date()
  return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10)
}

const readLedger = async () => (existsSync(LEDGER) ? parseLedger(await readFile(LEDGER, 'utf8')) : [])
// Pet settings: a missing or corrupt file means all defaults (parseSettings replaces individual bad values), so the pet is never affected
const readSettings = () => readFile(SETTINGS_FILE, 'utf8').then(JSON.parse).catch(() => ({}))
// Recurring plans: unlike settings, a broken file is an error the pet shows (silently dropping plans would shrink it)
const readPlans = async () => {
  if (!existsSync(PLANS_FILE)) return []
  try {
    return parsePlans(JSON.parse(await readFile(PLANS_FILE, 'utf8')))
  } catch (e) {
    throw new Error(`定期定額計畫讀取失敗：${e.message}`)
  }
}
// What the pet lives on: the ledger plus the contributions the recurring plans add up to by today
const records = async () => [...(await readLedger()), ...planRows(await readPlans(), today())]

async function refresh() {
  let state
  try {
    state = evaluate(await records(), today(), getMarket(), await readSettings())
  } catch (e) {
    state = { error: e.message }
  }
  pet()?.webContents.send('state', state)
}

// Shared by CSV import and broker sync: merge without duplicates and validate again before writing, so bad data never reaches the ledger.
// Writes are queued one at a time: two brokers syncing at once (or a CSV import during a sync) never overwrite each other.
// previous: the batch a snapshot broker's last sync wrote; it's removed before the new rows go in.
// Returns { added: number of rows not already in the ledger, inserted: rows actually written this time }; rows dropped as duplicates of existing ones don't count as written by the sync,
// so a later replacement never deletes entries the user made themselves
let writing = Promise.resolve()
function addRows(rows, previous = []) {
  const task = writing.then(async () => {
    const existing = await readLedger() // Abort without overwriting if the existing ledger is corrupt
    const base = removeRows(existing, previous)
    const merged = mergeLedger(base, rows)
    // Write a temp file, then rename (atomic): a forced quit or crash mid-write never leaves an empty ledger
    await writeFile(`${LEDGER}.tmp`, toCsv(parseLedger(toCsv(merged))))
    await rename(`${LEDGER}.tmp`, LEDGER)
    await refresh()
    return { added: removeRows(rows, existing).length, inserted: removeRows(rows, base) } // The count is never negative
  })
  writing = task.catch(() => {}) // A failed write doesn't affect the next one
  return task
}

async function importCsv() {
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '匯入交易紀錄',
    filters: [{ name: 'CSV', extensions: ['csv'] }],
    properties: ['openFile'],
  })
  if (canceled) return
  try {
    const { added } = await addRows(parseLedger(await readFile(filePaths[0], 'utf8')))
    dialog.showMessageBox(win, { message: `匯入完成，新增 ${added} 筆紀錄` })
  } catch (e) {
    dialog.showErrorBox('匯入失敗', e.message)
  }
}

async function exportBackup() {
  if (!existsSync(LEDGER)) return dialog.showMessageBox(win, { message: '還沒有任何紀錄可以備份' })
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    defaultPath: `nestegg-backup-${today()}.csv`,
    filters: [{ name: 'CSV', extensions: ['csv'] }],
  })
  if (!canceled) await copyFile(LEDGER, filePath)
}

// Changes save immediately and the pet updates right away, so no separate preview is needed
export function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) return settingsWin.focus()
  settingsWin = new BrowserWindow({
    width: 480,
    height: Math.min(1000, screen.getPrimaryDisplay().workArea.height), // Scrolls on small screens (for example, a 1366×768 laptop)
    title: '寵物設定',
    webPreferences: { preload: join(import.meta.dirname, 'preload.cjs') },
  })
  settingsWin.loadFile(join(import.meta.dirname, 'settings.html'))
  app.focus({ steal: true })
}

ipcMain.handle('settings:get', async () => ({ values: parseSettings(await readSettings()), limits: SETTINGS }))
// Only values that differ from the defaults are saved: "restore defaults" is an empty file, and future default changes still apply.
// Queue writes one at a time (like the ledger): the settings window saves on every field change, and rapid edits must not share a temp file and overwrite each other
let savingSettings = Promise.resolve()
ipcMain.handle('settings:set', (_e, input) => {
  const task = savingSettings.then(async () => {
    const values = parseSettings(input)
    const changed = Object.fromEntries(Object.entries(values).filter(([key, v]) => v !== SETTINGS[key].value))
    await writeFile(`${SETTINGS_FILE}.tmp`, JSON.stringify(changed, null, 2))
    await rename(`${SETTINGS_FILE}.tmp`, SETTINGS_FILE)
    await refresh()
    return values
  })
  savingSettings = task.catch(() => {}) // A failed save doesn't affect the next one
  return task
})

// One window for all recurring plans: each change saves the whole list, and the pet updates right away
export function openPlans() {
  if (plansWin && !plansWin.isDestroyed()) return plansWin.focus()
  plansWin = new BrowserWindow({
    width: 560,
    height: Math.min(860, screen.getPrimaryDisplay().workArea.height),
    title: '定期定額計畫',
    webPreferences: { preload: join(import.meta.dirname, 'preload.cjs') },
  })
  plansWin.loadFile(join(import.meta.dirname, 'plans.html'))
  app.focus({ steal: true })
}

// Each plan comes back with how many contributions it has recorded so far and their total
const describePlans = plans => ({
  today: today(),
  plans: plans.map(p => {
    const rows = planRows([p], today())
    return { ...p, count: rows.length, total: rows.reduce((n, r) => n + r.amount, 0) }
  }),
})
ipcMain.handle('plans:get', async () => describePlans(await readPlans()))
// Queued like the settings: the window can save twice in quick succession
let savingPlans = Promise.resolve()
ipcMain.handle('plans:set', (_e, input) => {
  const task = savingPlans.then(async () => {
    const plans = parsePlans(input) // Throws with the problem, which the window shows; nothing is saved
    await writeFile(`${PLANS_FILE}.tmp`, JSON.stringify(plans, null, 2))
    await rename(`${PLANS_FILE}.tmp`, PLANS_FILE)
    await refresh()
    return describePlans(plans)
  })
  savingPlans = task.catch(() => {})
  return task
})

async function showLedger() {
  if (!existsSync(LEDGER)) await writeFile(LEDGER, `${HEADER}\n`)
  shell.showItemInFolder(LEDGER)
}

const actions = [
  { label: '匯入交易紀錄 CSV…', click: importCsv },
  { label: '匯出備份…', click: exportBackup },
  { label: '在資料夾中顯示帳本（手動記帳）', click: showLedger },
  { label: '證券帳戶同步…', click: openSetup },
  { label: '定期定額計畫…', click: openPlans },
  { label: '寵物設定…', click: openSettings },
]
const menu = Menu.buildFromTemplate([...actions, { type: 'separator' }, { label: '結束 NestEgg', role: 'quit' }])

app.whenReady().then(() => {
  app.dock?.setMenu(Menu.buildFromTemplate(actions)) // Right-click menu on the Dock icon (macOS adds Quit itself)
  win = new BrowserWindow({
    ...placeAt(anchor, screen.getPrimaryDisplay().workArea, { width: W, height: H }),
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: { preload: join(import.meta.dirname, 'preload.cjs') },
  })
  // Don't use setVisibleOnAllWorkspaces: on macOS it makes the pet show up over other apps' full-screen windows (for example, a video).
  // The pet stays on the desktop it's on.
  // Clicks on transparent areas pass through to the windows behind; the renderer switches back when the mouse is over the pet (forward keeps mousemove events coming)
  win.setIgnoreMouseEvents(true, { forward: true })
  win.loadFile(join(import.meta.dirname, 'index.html'))
  win.webContents.on('did-finish-load', refresh)
  win.webContents.on('context-menu', () => menu.popup({ window: win }))
  // Re-read every 10 seconds to pick up manual ledger edits and the change of day
  setInterval(refresh, 10_000)
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, place)
  initBrokers({ today, onRows: addRows, say: text => pet()?.webContents.send('say', text) })
  startMarket({ symbols: async () => (await records().catch(() => [])).map(r => r.symbol), onUpdate: refresh })
})

// Clicking the Dock or taskbar icon makes the pet show a status bubble, so it's easy to find
app.on('activate', () => pet()?.webContents.send('say', null))

// Custom dragging: setBounds keeps the size fixed, because on high-DPI Windows setPosition makes the window grow as it's dragged
ipcMain.on('move', (_e, x, y) => {
  if (Number.isFinite(x) && Number.isFinite(y)) pet()?.setBounds({ x: Math.round(x), y: Math.round(y), width: W, height: H })
})
// On drop: remember the new corner and pull the pet back if it's off screen (not limited while dragging, so it can move to another display)
ipcMain.on('drop', () => {
  const w = pet()
  if (!w) return
  anchor = anchorOf(w.getBounds(), screen.getDisplayMatching(w.getBounds()).workArea)
  place()
})
ipcMain.on('solid', (_e, solid) => pet()?.setIgnoreMouseEvents(!solid, { forward: true }))
