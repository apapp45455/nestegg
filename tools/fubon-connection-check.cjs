// The connection test for the day you sign up for Fubon's next-generation API (Fubon SOP method 3: log in once with the account password).
// Only login and logout are called, and nothing is stored; what you type isn't shown on screen.
// Install the SDK with the NestEgg setup wizard first. Usage: node tools/fubon-connection-check.cjs [certificate path]
const { homedir } = require('node:os')
const { join } = require('node:path')
const readline = require('node:readline')

const DATA = process.platform === 'darwin'
  ? join(homedir(), 'Library', 'Application Support', 'NestEgg')
  : join(process.env.APPDATA ?? homedir(), 'NestEgg')
const SDK_DIR = join(DATA, 'fubon', 'package')
// Dragged-in or pasted paths can carry quotes or escaped spaces
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
    console.error('找不到憑證檔，請確認路徑。') // Check a path given on the command line first, so the user doesn't type their credentials for nothing
    return 1
  }
  const id = (await ask('身分證字號（不會顯示）：')).toUpperCase()
  const password = await ask('電子交易登入密碼（不會顯示）：')
  // The certificate can be given on the command line (some terminals can't drag files in); otherwise drag the .pfx in
  const certPath = argPath || unquote(await ask('憑證 .pfx 檔案路徑（可把檔案拖進來後按 Enter）：', false))
  if (!exists(certPath)) {
    console.error('找不到憑證檔，請確認路徑。')
    return 1
  }
  const certPass = await ask('憑證密碼（沒改過直接按 Enter）：')

  process.chdir(join(DATA, 'fubon')) // The SDK writes logs to the current folder
  const sdk = new CoreSdk(require(join(SDK_DIR, 'package.json')).version)
  const res = sdk.login(id, password, certPath, certPass || null)
  if (res.isSuccess) {
    try { sdk.logout() } catch {} // A failed logout doesn't change the "API is enabled" result
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

// Exit code: 0 on success (including a successful connection test), 1 on failure or error; ending before a result (for example, interrupted input) also counts as failure
process.exitCode = 1
main().then(code => process.exit(code), e => {
  console.error(`\n❌ ${e.message}`)
  process.exit(1)
})
