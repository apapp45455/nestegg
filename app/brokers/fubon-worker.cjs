// Runs the Fubon SDK in a separate utility process: every SDK call is synchronous (construction alone takes a second) and would freeze the pet in the main process.
// Only API-key login, the trade history query and logout are called here; there are no order-related calls.
const { join } = require('node:path')

process.parentPort.once('message', ({ data: { sdkDir, id, apiKey, certPath, certPass, windows } }) => {
  const reply = msg => process.parentPort.postMessage(msg) // The main process ends this process after the reply
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
          else errors.push(`${from}–${to}：${res.message}`) // Months without trades can also fail; collect the errors for now
        }
      }
    } finally {
      // Log out even if a query fails so no session is left open; a failed logout doesn't affect records already fetched
      try { sdk.logout() } catch {}
    }
    reply({ accounts: accounts.length, fills, errors })
  } catch (e) {
    reply({ error: e.message })
  }
})
