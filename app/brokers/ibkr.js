// Interactive Brokers through the Flex Web Service, IBKR's reporting service: a token and a Flex Query ID can only
// download that report, so nothing NestEgg stores can place an order.
// The shared flow lives in ../brokers.js; how trades become ledger rows lives in ../../sync/ibkr.js.
import { flexWindows, parseAccounts, parseCbcRates, parseFlexStatus, parseTrades, toRows } from '../../sync/ibkr.js'

const FLEX = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService'
const CBC = 'https://cpx.cbc.gov.tw/API/DataAPI/Get?FileName=BP01D01' // The central bank's daily exchange rates, all of them in one public file
const HEADERS = { 'User-Agent': 'NestEgg' } // IBKR refuses requests without one
const wait = ms => new Promise(r => setTimeout(r, ms))
const needsUser = message => Object.assign(new Error(message), { needsUser: true })

// Only the user can fix these in IBKR's settings: auto sync pauses instead of trying again every hour
const USER_ERRORS = {
  1010: '這個 Flex Query 是舊版格式，請在 IB 建立新的 Activity Flex Query',
  1011: 'IB 的 Flex Web Service 沒有啟用，請到 Flex Web Service 設定打開',
  1012: 'Flex Web Service 的金鑰過期了，請到 IB 產生新的金鑰，再重新連線',
  1013: '這把金鑰限制了 IP，現在的網路不在允許範圍內，請到 IB 的 Flex Web Service 設定修改',
  1014: 'IB 找不到這個 Flex Query，請確認 Query ID',
  1015: 'IB 說金鑰無效，請確認金鑰，或到 IB 產生新的金鑰再重新連線',
  1016: 'IB 回覆帳戶狀態異常，請到 IB 確認帳戶',
  1020: 'IB 無法驗證這次的請求，請確認金鑰與 Query ID',
}
// Not ready or too busy: ask again a little later
const RETRY = new Set([1001, 1004, 1005, 1006, 1007, 1008, 1009, 1018, 1019, 1021])

function check(status) {
  if (USER_ERRORS[status.code]) throw needsUser(`${USER_ERRORS[status.code]}（IB 錯誤 ${status.code}）`)
  if (!RETRY.has(status.code)) throw new Error(`IB 回覆錯誤 ${status.code}：${status.message}`)
}

// IBKR allows one request a second and ten a minute per token
function pacer() {
  const sent = []
  return async () => {
    const now = Date.now()
    await wait(Math.max(0, (sent.at(-1) ?? 0) + 1_100 - now, sent.length >= 10 ? sent.at(-10) + 61_000 - now : 0))
    sent.push(Date.now())
  }
}

async function get(url, pace) {
  await pace?.()
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(60_000) })
  if (!res.ok) throw new Error(`${new URL(url).host} 回應 ${res.status}`)
  return res.text()
}

// SendRequest asks IBKR to build the report, GetStatement fetches it once it's ready
async function statement(creds, [fd, td], pace) {
  const flex = (path, params) => get(`${FLEX}/${path}?${new URLSearchParams({ t: creds.token, ...params, v: '3' })}`, pace)
  let ref
  for (const delay of [0, 5_000, 15_000, 30_000]) {
    await wait(delay)
    const status = parseFlexStatus(await flex('SendRequest', { q: creds.queryId, fd, td }))
    if (status?.ok) {
      ref = status.referenceCode
      break
    }
    if (status) check(status)
  }
  if (!ref) throw new Error('IB 現在沒辦法產生報表，請稍後再試')
  for (const delay of [2_000, 3_000, 5_000, 10_000, 20_000, 30_000]) {
    await wait(delay)
    const xml = await flex('GetStatement', { q: ref })
    const status = parseFlexStatus(xml)
    if (!status) return xml
    check(status)
  }
  throw new Error('IB 的報表產生太久，請稍後再試')
}

export default {
  id: 'ibkr',
  name: 'Interactive Brokers（盈透）',
  // The central bank publishes a day's rate up to a week later, and a trade waits for its rate (see toRows in
  // sync/ibkr.js), so each daily sync looks back further than a week
  overlap: 60,

  credentials(form) {
    const creds = { token: String(form.token ?? '').trim(), queryId: String(form.queryId ?? '').trim() }
    if (!creds.token || !creds.queryId) throw new Error('請填寫 Flex Web Service 的金鑰與 Flex Query 的 Query ID')
    if (!/^\d+$/.test(creds.queryId)) throw new Error('Query ID 是一串數字，請到 IB 的 Flex Queries 頁面確認')
    return creds
  },

  async fetch({ creds, from, to }) {
    // Rates first: if they can't be read (offline, or a maintenance page instead of the data), no IBKR request is spent
    const rates = await get(CBC)
      .then(body => parseCbcRates(JSON.parse(body)))
      .catch(e => { throw new Error(`中央銀行的匯率下載失敗：${e.message}`) })
    const pace = pacer()
    const trades = [], accounts = new Set()
    for (const window of flexWindows(from, to)) {
      const xml = await statement(creds, window, pace)
      trades.push(...parseTrades(xml))
      for (const id of parseAccounts(xml)) accounts.add(id)
    }
    return { ...toRows(trades, rates, from, to), accounts: accounts.size }
  },
}
