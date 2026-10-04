// 端到端測試用的假富邦 SDK：介面跟真的 trade.js 的 CoreSdk 一樣，但不連網，回傳固定的成交紀錄。
// 測試可以在這個資料夾放 fail-login 檔案，模擬登入失敗。
const fs = require('node:fs')
const path = require('node:path')

const FILLS = [
  ['2025/11/06', 'Buy', 'Stock', 150, 64.0], ['2025/12/08', 'Buy', 'Stock', 148, 65.1],
  ['2026/01/06', 'Buy', 'Stock', 145, 66.2], ['2026/02/06', 'Buy', 'Stock', 140, 68.5],
  ['2026/03/06', 'Buy', 'Margin', 1000, 70.0], ['2026/03/06', 'Buy', 'Stock', 139, 69.0],
  ['2026/04/07', 'Buy', 'Stock', 141, 68.0], ['2026/05/06', 'Buy', 'Stock', 138, 69.6],
  ['2026/06/08', 'Buy', 'Stock', 135, 71.0], ['2026/07/06', 'Buy', 'Stock', 133, 72.3],
  ['2026/08/06', 'Buy', 'Stock', 130, 73.8], ['2026/09/07', 'Buy', 'Stock', 129, 74.4],
].map(([date, buySell, orderType, filledQty, filledPrice]) => ({ date, stockNo: '0050', buySell, orderType, filledQty, filledPrice }))

class CoreSdk {
  constructor(version) { this.version = version }
  apikeyLogin(id, apiKey, certPath) {
    if (fs.existsSync(path.join(__dirname, 'fail-login'))) return { isSuccess: false, message: 'API Key 無效（假的）' }
    if (!fs.existsSync(certPath)) return { isSuccess: false, message: '找不到憑證' }
    return { isSuccess: true, data: [
      { name: '測試', account: '1', branchNo: '0', accountType: 'stock' },
      { name: '期貨', account: '2', branchNo: '0', accountType: 'futopt' },
    ] }
  }
  get stock() {
    const key = d => d.replaceAll('/', '')
    return { filledHistory: (_account, from, to) => ({ isSuccess: true, data: FILLS.filter(f => key(f.date) >= from && key(f.date) <= to) }) }
  }
  logout() { return true }
}

module.exports = { CoreSdk }
