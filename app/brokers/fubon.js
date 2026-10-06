// Fubon Securities (next-generation API): SDK install checks, form fields and the sync. The shared flow lives in ../brokers.js.
// Every sync reconciles the current holdings (needs only the 證券業務 permission). Importing the past trade history needs
// the 證券下單 order permission, so it uses a separate key that is entered once when connecting and never saved.
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { holdings } from '../../engine/index.js'
import { dateWindows, fillsToRows, positionsOf, reconcile } from '../../sync/fubon.js'

const MIN_SDK = '2.2.7' // apikeyLogin first appeared in this version
const WORKER = join(import.meta.dirname, 'fubon-worker.cjs')
const needsUser = message => Object.assign(new Error(message), { needsUser: true })

export default {
  id: 'fubon',
  name: '富邦證券',
  snapshot: true, // each sync returns every row it owns: the previous ones plus what changed (see reconcile in sync/fubon.js)
  sdk: {
    label: '富邦 Node.js SDK',
    version: async dir => (existsSync(join(dir, 'trade.js')) ? JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')).version : null),
    // The download is a zip wrapping an npm .tgz, which extracts to package/
    async unpack(tmp, untar) {
      if (!existsSync(join(tmp, 'package'))) {
        const tgz = (await readdir(tmp)).find(f => f.endsWith('.tgz'))
        if (!tgz) throw new Error('zip 裡找不到 .tgz 檔')
        await untar(join(tmp, tgz), tmp)
      }
      const dir = join(tmp, 'package')
      const pkg = existsSync(join(dir, 'package.json')) ? JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) : {}
      if (pkg.name !== 'fubon-neo' || !existsSync(join(dir, 'trade.js'))) throw new Error('這不是富邦新一代 API 的 Node.js SDK')
      if (!pkg.version) throw new Error('讀不到 SDK 的版本，請重新下載')
      if (pkg.version.localeCompare(MIN_SDK, undefined, { numeric: true }) < 0) throw new Error(`SDK 版本 ${pkg.version} 太舊，需要 ${MIN_SDK} 以上`)
      return dir
    },
  },
  cert: { title: '選擇富邦憑證', name: '憑證', extensions: ['pfx', 'p12'] },

  credentials(form) {
    const creds = {
      id: String(form.id ?? '').trim().toUpperCase(),
      apiKey: String(form.apiKey ?? '').trim(),
      certPath: String(form.certPath ?? ''),
      certPass: String(form.certPass ?? ''),
    }
    if (!creds.id || !creds.apiKey || !creds.certPath) throw new Error('請填寫身分證字號、API Key，並選擇憑證檔')
    if (!existsSync(creds.certPath)) throw new Error('找不到憑證檔，請重新選擇')
    return creds
  },
  // The optional history key: used for this one connection, never saved
  connectOnly: form => ({ historyKey: String(form.historyKey ?? '').trim() }),

  // Every SDK call is synchronous (construction alone takes a second), so it runs in a separate utility process to keep the pet responsive
  async fetch({ creds, from, to, sdkDir, runWorker, previous, connectOnly, manual }) {
    // The worker stops querying 15 s before the timeout so it can still log out; the timeout itself only catches a hung SDK call
    const run = async (apiKey, payload, timeout = 120_000) => {
      const res = await runWorker(WORKER, { sdkDir, ...creds, apiKey, deadline: Date.now() + timeout - 15_000, ...payload }, timeout)
      if (/連線測試成功/.test(res.error ?? '')) throw new Error('富邦回覆連線測試成功，API 權限會在簽署隔天 9:00 前開通，到時候再按一次「連線並同步」。')
      if (res.loginFailed) throw needsUser(res.error) // Login failed: pause auto sync so the account doesn't get locked
      if (res.error) throw new Error(res.error)
      if (res.throttled) throw new Error('富邦限制了查詢次數（業務系統流量控管），這次先不更新。請過幾分鐘再試')
      if (res.timedOut) throw new Error('富邦回應太慢，這次沒有查完，帳本先不更新。請過幾分鐘再試')
      return res
    }

    let owned = previous, warnings = []
    if (connectOnly?.historyKey) {
      const windows = dateWindows(from, to)
      // Up to 30 days per query: allow time for each window, plus backing off if Fubon throttles
      const res = await run(connectOnly.historyKey, { history: windows }, 120_000 + windows.length * 5_000).catch(e => {
        throw Object.assign(e, { message: `歷史匯入用的 API Key：${e.message}` })
      })
      if (res.unauthorized) throw new Error('歷史匯入用的 API Key 沒有「證券下單」權限，查不到過去的成交紀錄。請確認這把金鑰有勾「證券下單」，或把這一欄留空，只同步之後的變化')
      if (!res.fills.length && res.errors.length) throw new Error(`查詢成交紀錄失敗：${res.errors[0]}`)
      // Importing history rebuilds the rows this sync owns from scratch: holdings recorded earlier by reconciling
      // (for example, bought "today" when first connected without history) are replaced by the real trades, not counted twice
      owned = fillsToRows(res.fills)
      warnings = res.errors
    }

    const res = await run(creds.apiKey, {})
    if (res.unauthorized) throw needsUser('這把 API Key 沒有「證券業務」權限，查不到持股。請到富邦的金鑰管理頁確認有勾「證券業務」')
    // A partial list would look like sells, so any failed account stops the sync
    if (res.errors.length) throw new Error(`查詢持股失敗：${res.errors[0]}`)
    const positions = positionsOf(res.assets)
    // No holdings at all, but some were recorded: maybe a temporary empty answer (maintenance), maybe everything was
    // sold. Auto sync doesn't guess; it stops and asks the user to confirm
    if (!manual && !Object.keys(positions).length && [...holdings(owned, to).values()].some(h => h.shares > 0)) {
      throw needsUser('富邦這次沒有回傳任何持股，先不更新帳本。如果你已經全部賣出，請按「立即同步」確認')
    }
    return { rows: [...owned, ...reconcile(positions, owned, to)], accounts: res.accounts, warnings }
  },
}
