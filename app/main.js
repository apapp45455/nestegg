import { app, BrowserWindow, Menu, dialog, ipcMain, screen, shell } from 'electron'
import { existsSync } from 'node:fs'
import { copyFile, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { HEADER, evaluate, mergeLedger, parseLedger, removeRows, toCsv } from '../engine/index.js'
import { initBrokers, openSetup } from './brokers.js'
import { getMarket, startMarket } from './market.js'
import { anchorOf, placeAt } from './placement.js'

const W = 200, H = 300
const LEDGER = join(app.getPath('userData'), 'ledger.csv')
let win
// 結束時視窗會先被銷毀，計時器、滑鼠事件、螢幕變化卻可能還在進來 —— 一律透過這裡拿視窗
const pet = () => (win && !win.isDestroyed() ? win : null)
let anchor = { right: 40, bottom: 0 } // 寵物貼著哪個角落、距離多少；預設右下角

// 換螢幕、改解析度、Dock 變大小時，照同樣的角落與距離重新擺好，不會跑出畫面
function place() {
  const w = pet()
  if (!w) return
  const { workArea } = screen.getDisplayMatching(w.getBounds())
  w.setBounds(placeAt(anchor, workArea, { width: W, height: H }))
}

// 本地日期 YYYY-MM-DD（toISOString 是 UTC，台灣早上 8 點前會差一天）
const today = () => {
  const d = new Date()
  return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 10)
}

const readLedger = async () => (existsSync(LEDGER) ? parseLedger(await readFile(LEDGER, 'utf8')) : [])

async function refresh() {
  let state
  try {
    state = evaluate(await readLedger(), today(), getMarket())
  } catch (e) {
    state = { error: e.message }
  }
  pet()?.webContents.send('state', state)
}

// CSV 匯入與券商同步共用：合併去重、寫入前再驗一次，壞資料不會進帳本。
// 排隊一筆一筆寫：兩家券商同時同步（或同步時匯入 CSV）也不會互相蓋掉。
// previous：快照型券商上次同步寫進來的那批，先拿掉再放新的。
// 回傳 { added: 原本帳本沒有的筆數, inserted: 這次真的寫進去的列 }；跟帳本已有的列相同而被去重的不算同步寫的，
// 之後取代時才不會刪到你自己記的帳
let writing = Promise.resolve()
function addRows(rows, previous = []) {
  const task = writing.then(async () => {
    const existing = await readLedger() // 原帳本壞掉時直接中止，不覆蓋
    const base = removeRows(existing, previous)
    const merged = mergeLedger(base, rows)
    // 先寫暫存檔再改名（原子操作）：寫到一半被強制結束或當機，帳本也不會變成空檔
    await writeFile(`${LEDGER}.tmp`, toCsv(parseLedger(toCsv(merged))))
    await rename(`${LEDGER}.tmp`, LEDGER)
    await refresh()
    return { added: removeRows(rows, existing).length, inserted: removeRows(rows, base) } // 筆數不會是負的
  })
  writing = task.catch(() => {}) // 這一筆失敗不影響下一筆
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

async function showLedger() {
  if (!existsSync(LEDGER)) await writeFile(LEDGER, `${HEADER}\n`)
  shell.showItemInFolder(LEDGER)
}

const actions = [
  { label: '匯入交易紀錄 CSV…', click: importCsv },
  { label: '匯出備份…', click: exportBackup },
  { label: '在資料夾中顯示帳本（手動記帳）', click: showLedger },
  { label: '證券帳戶同步…', click: openSetup },
]
const menu = Menu.buildFromTemplate([...actions, { type: 'separator' }, { label: '結束 NestEgg', role: 'quit' }])

app.whenReady().then(() => {
  app.dock?.setMenu(Menu.buildFromTemplate(actions)) // Dock 圖示右鍵（系統會自己加上「結束」）
  win = new BrowserWindow({
    ...placeAt(anchor, screen.getPrimaryDisplay().workArea, { width: W, height: H }),
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: { preload: join(import.meta.dirname, 'preload.cjs') },
  })
  // 不要 setVisibleOnAllWorkspaces：macOS 上它會讓寵物出現在別的 app 的全螢幕畫面（例如看影片）。
  // 寵物就待在它所在的桌面。
  // 透明區域讓點擊穿透到後面的視窗；滑鼠移到寵物上時由 renderer 切回來（forward 讓 mousemove 照樣送進來）
  win.setIgnoreMouseEvents(true, { forward: true })
  win.loadFile(join(import.meta.dirname, 'index.html'))
  win.webContents.on('did-finish-load', refresh)
  win.webContents.on('context-menu', () => menu.popup({ window: win }))
  // 每 10 秒重讀：接住手動編輯帳本，也接住跨日
  setInterval(refresh, 10_000)
  for (const event of ['display-added', 'display-removed', 'display-metrics-changed']) screen.on(event, place)
  initBrokers({ today, onRows: addRows, say: text => pet()?.webContents.send('say', text) })
  startMarket({ symbols: async () => (await readLedger().catch(() => [])).map(r => r.symbol), onUpdate: refresh })
})

// 點 Dock／工作列圖示：寵物冒出狀態氣泡，方便找到牠
app.on('activate', () => pet()?.webContents.send('say', null))

// 自訂拖曳：用 setBounds 固定尺寸，避免 Windows 高 DPI 下 setPosition 讓視窗越拖越大
ipcMain.on('move', (_e, x, y) => {
  if (Number.isFinite(x) && Number.isFinite(y)) pet()?.setBounds({ x: Math.round(x), y: Math.round(y), width: W, height: H })
})
// 放開拖曳：記住新的角落；拖到螢幕外的拉回來（拖曳中不限制，才能拖到另一個螢幕）
ipcMain.on('drop', () => {
  const w = pet()
  if (!w) return
  anchor = anchorOf(w.getBounds(), screen.getDisplayMatching(w.getBounds()).workArea)
  place()
})
ipcMain.on('solid', (_e, solid) => pet()?.setIgnoreMouseEvents(!solid, { forward: true }))
