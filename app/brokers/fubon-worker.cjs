// Runs the Fubon SDK in a separate utility process: every SDK call is synchronous (construction alone takes a second) and would freeze the pet in the main process.
// Only API-key login, read-only queries and logout are called here; there are no order-related calls.
// - history (date windows): stock.filledHistory, the trade history (Fubon requires the 證券下單 permission for it)
// - otherwise: accounting.unrealizedGainsAndLoses, the current holdings (needs only 證券業務)
const { join } = require('node:path')

const UNAUTHORIZED = /未授權/ // "此 API KEY 未授權該功能": the key lacks the permission this query needs
const THROTTLED = /流量控管/ // "業務系統流量控管": too many queries too quickly
const RETRY_WAITS = [2_000, 4_000, 8_000, 16_000]
const PACE = 1_000
// The SDK is synchronous, so this process can simply block while it waits
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const NO_DATA = /查無|無資料/ // ponytail: assumes an account without holdings answers like this; unverified on a real account

process.parentPort.once('message', ({ data: { sdkDir, id, apiKey, certPath, certPass, history } }) => {
  const reply = msg => process.parentPort.postMessage(msg) // The main process ends this process after the reply
  try {
    const { CoreSdk } = require(join(sdkDir, 'trade.js'))
    const sdk = new CoreSdk(require(join(sdkDir, 'package.json')).version)
    const login = sdk.apikeyLogin(id, apiKey, certPath, certPass || null)
    if (!login.isSuccess) return reply({ error: `登入失敗：${login.message}`, loginFailed: true })

    const accounts = login.data.filter(a => a.accountType !== 'futopt')
    const fills = [], assets = [], errors = []
    let unauthorized = false, throttled = false, paced = false
    // Fubon doesn't publish its query limit. Query at full speed until it says 流量控管, then back off and retry,
    // and keep one query per second from then on; if it still refuses, stop instead of returning a partial history
    const query = call => {
      if (paced) sleep(PACE)
      let res = call()
      for (const wait of RETRY_WAITS) {
        if (!THROTTLED.test(res.message ?? '')) break
        paced = true
        sleep(wait)
        res = call()
      }
      return res
    }
    const collect = (res, into, label) => {
      if (res.isSuccess) into.push(...(res.data ?? []))
      else if (UNAUTHORIZED.test(res.message ?? '')) unauthorized = true
      else if (THROTTLED.test(res.message ?? '')) throttled = true
      else if (!NO_DATA.test(res.message ?? '')) errors.push(`${label}${res.message}`)
    }
    try {
      for (const account of accounts) {
        if (history) {
          // Months without trades can also fail; collect the errors and stop at the first permission error
          for (const [from, to] of history) {
            collect(query(() => sdk.stock.filledHistory(account, from, to)), fills, `${from}–${to}：`)
            if (unauthorized || throttled) break
          }
        } else {
          collect(query(() => sdk.accounting.unrealizedGainsAndLoses(account)), assets, '')
        }
        if (unauthorized || throttled) break
      }
    } finally {
      // Log out even if a query fails so no session is left open; a failed logout doesn't affect records already fetched
      try { sdk.logout() } catch {}
    }
    reply({ accounts: accounts.length, fills, assets, errors, unauthorized, throttled })
  } catch (e) {
    reply({ error: e.message })
  }
})
