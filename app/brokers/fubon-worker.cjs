// 在獨立的 utility process 跑富邦 SDK：SDK 全是同步呼叫（光建構就要 1 秒），放主程序會卡住寵物。
// 這裡只呼叫 API Key 登入、成交紀錄查詢、登出 —— 沒有任何下單相關的呼叫。
const { join } = require('node:path')

process.parentPort.once('message', ({ data: { sdkDir, id, apiKey, certPath, certPass, windows } }) => {
  const reply = msg => process.parentPort.postMessage(msg) // 回覆後由主程序結束這個 process
  try {
    const { CoreSdk } = require(join(sdkDir, 'trade.js'))
    const sdk = new CoreSdk(require(join(sdkDir, 'package.json')).version)
    const login = sdk.apikeyLogin(id, apiKey, certPath, certPass || null)
    if (!login.isSuccess) return reply({ error: `登入失敗：${login.message}`, loginFailed: true })

    const accounts = login.data.filter(a => a.accountType !== 'futopt')
    const fills = [], errors = []
    try {
      for (const account of accounts) {
        for (const [from, to] of windows) {
          const res = sdk.stock.filledHistory(account, from, to)
          if (res.isSuccess) fills.push(...(res.data ?? []))
          else errors.push(`${from}–${to}：${res.message}`) // 沒成交的月份也可能回失敗，先收著
        }
      }
    } finally {
      sdk.logout() // 查詢中途出錯也要登出，不留下連線
    }
    reply({ accounts: accounts.length, fills, errors })
  } catch (e) {
    reply({ error: e.message })
  }
})
