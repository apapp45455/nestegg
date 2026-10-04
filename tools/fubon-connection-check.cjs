// 富邦新一代 API 簽署當天的「連線測試」（富邦 SOP 方法三：用帳號密碼登入一次）。
// 只呼叫 login 與 logout，不儲存任何資料；輸入的內容不會顯示在畫面上。
// 需要先在 NestEgg 設定精靈安裝 SDK。用法：node tools/fubon-connection-check.cjs
const { homedir } = require('node:os')
const { join } = require('node:path')
const readline = require('node:readline')

const DATA = process.platform === 'darwin'
  ? join(homedir(), 'Library', 'Application Support', 'NestEgg')
  : join(process.env.APPDATA ?? homedir(), 'NestEgg')
const SDK_DIR = join(DATA, 'fubon', 'package')

function ask(prompt, hidden = true) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    process.stdout.write(prompt)
    rl._writeToOutput = s => rl.output.write(hidden ? (s.includes('\n') ? '' : '*') : s)
    rl.question('', answer => {
      rl.close()
      if (hidden) process.stdout.write('\n')
      resolve(answer.trim())
    })
  })
}

async function main() {
  let CoreSdk
  try {
    ({ CoreSdk } = require(join(SDK_DIR, 'trade.js')))
  } catch {
    console.error('找不到富邦 SDK，請先在 NestEgg 設定精靈安裝 SDK。')
    process.exit(1)
  }
  const id = (await ask('身分證字號（不會顯示）：')).toUpperCase()
  const password = await ask('電子交易登入密碼（不會顯示）：')
  // 可以直接把 .pfx 拖進終端機：去掉引號與跳脫的空白
  const certPath = (await ask('憑證 .pfx 檔案路徑（可把檔案拖進來後按 Enter）：', false))
    .replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' ')
  const certPass = await ask('憑證密碼（沒改過直接按 Enter）：')

  process.chdir(join(DATA, 'fubon')) // SDK 會在目前資料夾寫 log
  const sdk = new CoreSdk(require(join(SDK_DIR, 'package.json')).version)
  const res = sdk.login(id, password, certPath, certPass || null)
  if (res.isSuccess) {
    sdk.logout()
    console.log('\n✅ 登入成功：API 已經開通，可以回 NestEgg 做「連線並同步」了。')
  } else if (/連線測試成功/.test(res.message ?? '')) {
    console.log(`\n✅ 富邦回覆：${res.message}`)
    console.log('如果你今天已經在 e櫃台簽署，這就代表連線測試成功；API 會在明天 9:00 前開通。')
  } else {
    console.log(`\n❌ 富邦回覆：${res.message}`)
  }
}

main().catch(e => console.error(`\n❌ ${e.message}`)).finally(() => process.exit(0))
