// Sinopac Securities (Shioaji): runs a temporary local API server with the official shioaji command-line program, calls only account queries, then shuts it down.
// The shared flow lives in ../brokers.js; how account data becomes ledger rows lives in ../../sync/sinopac.js.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { toRows } from '../../sync/sinopac.js'

const BIN = process.platform === 'win32' ? 'shioaji.exe' : 'shioaji'
const OS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform]
const ARCH = { arm64: 'aarch64', x64: 'x86_64' }[process.arch]
const wait = ms => new Promise(r => setTimeout(r, ms))
// Errors only the user can fix (login failure, wrong permissions, simulation mode): the shared flow pauses auto sync so the account doesn't get locked
const needsUser = message => Object.assign(new Error(message), { needsUser: true })
// Only messages that clearly say authentication failed count as a login failure (auto sync pauses); anything else, or anything mentioning timeouts, the network or maintenance, is treated as temporary and retried next hour
const AUTH_ERROR = /invalid (api[ _-]?key|secret|token|credential)|unauthori[sz]ed|authentication failed|login failed|\b40[13]\b|金鑰(錯誤|無效)|認證失敗|登入失敗/i
const TRANSIENT = /time(d)? ?out|network|unreachable|connection|maintenance|維護|逾時|斷線/i

const freePort = () => new Promise((resolve, reject) => {
  const srv = createServer().once('error', reject).listen(0, '127.0.0.1', () => {
    const { port } = srv.address()
    srv.close(() => resolve(port))
  })
})

// Environment for the child process: none of the user's own SJ_CA_PATH, SJ_CA_PASSWD, SJ_API_KEY… are passed through,
// only NestEgg's own. Without a certificate, Shioaji can't place orders.
export const serverEnv = (creds, port, home, env = process.env) => ({
  ...Object.fromEntries(Object.entries(env).filter(([k]) => !k.toUpperCase().startsWith('SJ_'))),
  SJ_API_KEY: creds.apiKey,
  SJ_SEC_KEY: creds.secretKey,
  SJ_PRODUCTION: 'true',
  SJ_HTTP_ADDR: `127.0.0.1:${port}`,
  SJ_UDS_DISABLE: 'true',
  SJ_HTTP_CORS: 'false', // Don't let web pages in a browser call this temporary server
  SJ_HOME_PATH: join(home, 'shioaji'), // Login tokens and contract files stay in NestEgg's folder, separate from the user's own Shioaji
})

export default {
  id: 'sinopac',
  name: '永豐金證券',
  snapshot: true, // Only current positions and realized P&L are available, so each sync replaces the previous batch (see sync/sinopac.js)
  sdk: {
    label: 'Shioaji 命令列程式',
    version: async dir => (existsSync(join(dir, BIN)) ? (await readFile(join(dir, 'version.txt'), 'utf8')).trim() : null),
    // The GitHub download shioaji-v1.7.7-macOS-aarch64.tar.gz (.zip on Windows) extracts to a single executable
    async unpack(tmp) {
      const files = await readdir(tmp)
      const archive = files.find(f => /^shioaji-v\d/.test(f)) ?? ''
      if (archive && !archive.includes(`-${OS}-`)) throw new Error(`這是給其他作業系統的版本，請下載檔名有「${OS}」的那個`)
      // Apple silicon can run the x86_64 build (Rosetta), but not the other way round
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

  // Start a Shioaji server that listens only on localhost, on a random port
  async server(bin, creds, home) {
    const port = await freePort()
    // Every Shioaji start creates a folder named after its address in observability/; the port changes each time, so they pile up unless cleared. Keep only this run's.
    // If it can't be removed (for example, a file still in use on Windows), try again next time instead of blocking the sync
    await rm(join(home, 'shioaji', 'observability'), { recursive: true, force: true }).catch(() => {})
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
        const detail = `（代碼 ${code}）：${log.trim() || '沒有訊息'}` // The shared flow masks keys in this message
        reject(AUTH_ERROR.test(log) && !TRANSIENT.test(log) ? needsUser(`Shioaji 登入失敗${detail}`) : new Error(`Shioaji 啟動失敗，下個小時再試${detail}`))
      })
    })
    exited.catch(() => {}) // A normal shutdown after the queries also ends up here
    const url = `http://127.0.0.1:${port}`
    const ready = (async () => {
      for (const end = Date.now() + 90_000; !dead && Date.now() < end; await wait(500)) {
        // Wait at most 2 seconds per check: if another program took the port or Shioaji hangs, this is what makes the 90-second deadline work and releases the sync lock
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
      // Only account query APIs are used; account_type S is the securities account
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
      return { rows, accounts: 1, warnings, skipped } // ponytail: only the default securities account is queried; add account selection for people with several
    } finally {
      stop()
    }
  },
}
