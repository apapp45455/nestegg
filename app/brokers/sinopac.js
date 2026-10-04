// 永豐金證券（Shioaji）：用官方的 shioaji 命令列程式在本機開一個暫時的 API 伺服器，只呼叫帳務查詢，查完就關掉。
// 共用的流程在 ../brokers.js；帳務資料怎麼拼成帳本列在 ../../sync/sinopac.js。
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { toRows } from '../../sync/sinopac.js'

const BIN = process.platform === 'win32' ? 'shioaji.exe' : 'shioaji'
const OS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform]
const ARCH = { arm64: 'aarch64', x64: 'x86_64' }[process.arch]
const wait = ms => new Promise(r => setTimeout(r, ms))
// 要使用者處理才會好的錯誤（登入失敗、權限不對、模擬環境）：共用流程會因此暫停自動同步，免得帳號被鎖
const needsUser = message => Object.assign(new Error(message), { needsUser: true })
// 錯誤訊息明確是認證失敗才算登入失敗（自動同步暫停）；比對不到、或提到逾時／網路／維護的，一律當暫時問題下個小時再試
const AUTH_ERROR = /invalid (api[ _-]?key|secret|token|credential)|unauthori[sz]ed|authentication failed|login failed|\b40[13]\b|金鑰(錯誤|無效)|認證失敗|登入失敗/i
const TRANSIENT = /time(d)? ?out|network|unreachable|connection|maintenance|維護|逾時|斷線/i

const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = srv.address()
    srv.close(() => resolve(port))
  })
})

// 子程序的環境變數：使用者自己設的 SJ_CA_PATH、SJ_CA_PASSWD、SJ_API_KEY… 一個都不帶進去，
// 只放 NestEgg 自己的。沒有憑證，Shioaji 就不能下單。
export const serverEnv = (creds, port, home, env = process.env) => ({
  ...Object.fromEntries(Object.entries(env).filter(([k]) => !k.toUpperCase().startsWith('SJ_'))),
  SJ_API_KEY: creds.apiKey,
  SJ_SEC_KEY: creds.secretKey,
  SJ_PRODUCTION: 'true',
  SJ_HTTP_ADDR: `127.0.0.1:${port}`,
  SJ_UDS_DISABLE: 'true',
  SJ_HTTP_CORS: 'false', // 不讓瀏覽器裡的網頁呼叫這個暫時的伺服器
  SJ_HOME_PATH: join(home, 'shioaji'), // 登入權杖、商品檔放在 NestEgg 的資料夾，不跟你自己的 Shioaji 混在一起
})

export default {
  id: 'sinopac',
  name: '永豐金證券',
  snapshot: true, // 查得到的是目前持倉與已實現損益，每次同步取代上次的那批（見 sync/sinopac.js）
  sdk: {
    label: 'Shioaji 命令列程式',
    version: async dir => (existsSync(join(dir, BIN)) ? (await readFile(join(dir, 'version.txt'), 'utf8')).trim() : null),
    // GitHub 下載的 shioaji-v1.7.7-macOS-aarch64.tar.gz（Windows 是 .zip），解開就是一個執行檔
    async unpack(tmp) {
      const files = await readdir(tmp)
      const archive = files.find(f => /^shioaji-v\d/.test(f)) ?? ''
      if (archive && !archive.includes(`-${OS}-`)) throw new Error(`這是給其他作業系統的版本，請下載檔名有「${OS}」的那個`)
      // Apple 晶片可以跑 x86_64 版（Rosetta），反過來不行
      if (archive.includes('-aarch64') && ARCH !== 'aarch64') throw new Error(`這是 Apple 晶片／ARM 的版本，這台電腦請下載檔名有「${ARCH}」的那個`)
      if (!files.includes(BIN)) throw new Error(`這不是 Shioaji 命令列程式的壓縮檔（裡面找不到 ${BIN}）`)
      const dir = join(tmp, 'cli')
      await mkdir(dir)
      await rename(join(tmp, BIN), join(dir, BIN))
      await writeFile(join(dir, 'version.txt'), archive.match(/^shioaji-v([^-]+)/)?.[1] ?? '?')
      return dir
    },
  },

  credentials(form) {
    const creds = { apiKey: String(form.apiKey ?? '').trim(), secretKey: String(form.secretKey ?? '').trim() }
    if (!creds.apiKey || !creds.secretKey) throw new Error('請填寫 API Key 與 Secret Key')
    return creds
  },

  // 開一個只聽本機、隨機埠的 Shioaji 伺服器
  async server(bin, creds, home) {
    const port = await freePort()
    const child = spawn(bin, ['server', 'start', '--production', '--no-open'], {
      cwd: home,
      windowsHide: true,
      stdio: ['ignore', 'ignore', 'pipe'],
      env: serverEnv(creds, port, home),
    })
    let log = '', dead = false
    child.stderr.on('data', d => { log = (log + d).slice(-400) })
    const exited = new Promise((_, reject) => {
      child.once('error', e => { dead = true; reject(needsUser(`無法執行 Shioaji，請重新安裝：${e.message}`)) })
      child.once('exit', code => {
        dead = true
        const detail = `（代碼 ${code}）：${log.trim() || '沒有訊息'}`
        reject(AUTH_ERROR.test(log) && !TRANSIENT.test(log) ? needsUser(`Shioaji 登入失敗${detail}`) : new Error(`Shioaji 啟動失敗，下個小時再試${detail}`))
      })
    })
    exited.catch(() => {}) // 查完後正常關掉也會走到這裡
    const url = `http://127.0.0.1:${port}`
    const ready = (async () => {
      for (const end = Date.now() + 90_000; !dead && Date.now() < end; await wait(500)) {
        // 每次檢查最多等 2 秒：埠被別的程式佔走、或 Shioaji 卡住不回應時，90 秒期限才有用，同步鎖也才會放開
        const health = await fetch(`${url}/api/v1/health`, { signal: AbortSignal.timeout(2_000) }).then(r => r.json()).catch(() => null)
        if (health?.status === 'healthy') return
      }
      if (!dead) throw new Error('Shioaji 啟動逾時，請稍後再試')
    })()
    try {
      await Promise.race([ready, exited])
    } catch (e) {
      child.kill()
      throw e
    }
    return { url, stop: () => child.kill() }
  },

  async fetch({ creds, from, to, home, sdkDir }) {
    const { url, stop } = await this.server(join(sdkDir, BIN), creds, home)
    try {
      // 只用帳務查詢的 API；account_type S 是證券帳戶
      const call = async (path, body) => {
        const res = await fetch(url + path, {
          ...(body && { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ account_type: 'S', ...body }) }),
          signal: AbortSignal.timeout(60_000),
        })
        const data = await res.json().catch(() => null)
        const message = `永豐回應錯誤：${data?.message ?? `HTTP ${res.status}`}`
        if (!res.ok) throw [401, 403].includes(res.status) ? needsUser(`${message}（請確認 API Key 有勾「帳務」）`) : new Error(message)
        return data
      }
      const list = async (path, body) => {
        const data = await call(path, body)
        if (!Array.isArray(data)) throw new Error(`看不懂永豐回傳的 ${path}，可能是 Shioaji 改版了`)
        return data
      }
      if ((await call('/api/v1/info')).simulation !== false) throw needsUser('Shioaji 跑在模擬環境，查到的不是你的真實帳戶。請確認 API Key 有勾「正式環境」')

      const positions = await list('/api/v1/portfolio/position_unit', { unit: 'Share' })
      const positionDetails = {}
      for (const p of positions) positionDetails[p.id] = await list('/api/v1/portfolio/position_detail', { detail_id: p.id })
      const profitLoss = await list('/api/v1/portfolio/profit_loss', { begin_date: from, end_date: to, unit: 'Share' })
      const profitDetails = {}
      for (const pl of profitLoss) profitDetails[pl.id] = await list('/api/v1/portfolio/profit_loss_detail', { detail_id: pl.id, unit: 'Share' })

      const { rows, warnings, skipped } = toRows({ positions, positionDetails, profitLoss, profitDetails })
      return { rows, accounts: 1, warnings, skipped } // ponytail: 只查預設的證券帳戶；有多個證券帳戶的人再加帳戶選擇
    } finally {
      stop()
    }
  },
}
