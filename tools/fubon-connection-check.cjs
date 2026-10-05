// 富邦新一代 API 簽署當天的「連線測試」（富邦 SOP 方法三：用帳號密碼登入一次）。
// 只呼叫 login 與 logout，不儲存任何資料；輸入的內容不會顯示在畫面上。
// 需要先在 NestEgg 設定精靈安裝 SDK。用法：node tools/fubon-connection-check.cjs [憑證檔路徑]
const { homedir } = require('node:os')
const { join } = require('node:path')
const readline = require('node:readline')

const DATA = process.platform === 'darwin'
  ? join(homedir(), 'Library', 'Application Support', 'NestEgg')
  : join(process.env.APPDATA ?? homedir(), 'NestEgg')
const SDK_DIR = join(DATA, 'fubon', 'package')
// 拖進來或貼上的路徑可能帶引號或跳脫的空白
const unquote = path => path.replace(/^['"]|['"]$/g, '').replace(/\\ /g, ' ')

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
  const exists = path => require('node:fs').existsSync(path)
  const argPath = process.argv[2] && unquote(process.argv[2])
  if (argPath && !exists(argPath)) {
    console.error('找不到憑證檔，請確認路徑。') // 指令帶了路徑就先檢查，不用白輸入一次帳密
    return 1
  }
  const id = (await ask('身分證字號（不會顯示）：')).toUpperCase()
  const password = await ask('電子交易登入密碼（不會顯示）：')
  // 憑證檔可以直接寫在指令後面（有些終端機不能拖檔案）；否則把 .pfx 拖進來
  const certPath = argPath || unquote(await ask('憑證 .pfx 檔案路徑（可把檔案拖進來後按 Enter）：', false))
  if (!exists(certPath)) {
    console.error('找不到憑證檔，請確認路徑。')
    return 1
  }
  const certPass = await ask('憑證密碼（沒改過直接按 Enter）：')

  process.chdir(join(DATA, 'fubon')) // SDK 會在目前資料夾寫 log
  const sdk = new CoreSdk(require(join(SDK_DIR, 'package.json')).version)
  const res = sdk.login(id, password, certPath, certPass || null)
  if (res.isSuccess) {
    try { sdk.logout() } catch {} // 登出失敗不影響「已經開通」這個結果
    console.log('\n✅ 登入成功：API 已經開通，可以回 NestEgg 做「連線並同步」了。')
    return 0
  }
  if (/連線測試成功/.test(res.message ?? '')) {
    console.log(`\n✅ 富邦回覆：${res.message}`)
    console.log('如果你今天已經在 e櫃台簽署，這就代表連線測試成功；API 會在明天 9:00 前開通。')
    return 0
  }
  console.log(`\n❌ 富邦回覆：${res.message}`)
  return 1
}

// 結束碼：成功（含連線測試成功）是 0，失敗或出錯是 1；沒跑到結果就結束（例如輸入被中斷）也算失敗
process.exitCode = 1
main().then(code => process.exit(code), e => {
  console.error(`\n❌ ${e.message}`)
  process.exit(1)
})
