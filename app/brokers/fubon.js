// Fubon Securities (next-generation API): SDK install checks, form fields and the trade history query. The shared flow lives in ../brokers.js.
import { existsSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { dateWindows, fillsToRows } from '../../sync/fubon.js'

const MIN_SDK = '2.2.7' // apikeyLogin first appeared in this version

export default {
  id: 'fubon',
  name: '富邦證券',
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

  // Every SDK call is synchronous (construction alone takes a second), so it runs in a separate utility process to keep the pet responsive
  async fetch({ creds, from, to, sdkDir, runWorker }) {
    const res = await runWorker(join(import.meta.dirname, 'fubon-worker.cjs'), { sdkDir, ...creds, windows: dateWindows(from, to) })
    if (/連線測試成功/.test(res.error ?? '')) throw new Error('富邦回覆連線測試成功，API 權限會在簽署隔天 9:00 前開通，到時候再按一次「連線並同步」。')
    if (res.loginFailed) throw Object.assign(new Error(res.error), { needsUser: true }) // Login failed: pause auto sync so the account doesn't get locked
    if (res.error) throw new Error(res.error)
    if (!res.fills.length && res.errors.length) throw new Error(`查詢成交紀錄失敗：${res.errors[0]}`)
    return { rows: fillsToRows(res.fills), accounts: res.accounts, warnings: res.errors }
  },
}
