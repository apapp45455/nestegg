// 永豐 adapter 真正開 Shioaji 伺服器的那一段（e2e 換成假伺服器，測不到這裡）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sinopac, { serverEnv } from './sinopac.js'

const creds = { apiKey: 'k', secretKey: 's' }

test('sinopac: 使用者環境裡的 SJ_ 變數（例如憑證）不會帶進 Shioaji', () => {
  const env = serverEnv(creds, 1234, '/data', { PATH: '/bin', SJ_CA_PATH: '/me.pfx', sj_ca_passwd: 'x', SJ_API_KEY: 'mine' })
  assert.deepEqual(Object.keys(env).filter(k => /^SJ_/i.test(k)).sort(), ['SJ_API_KEY', 'SJ_HOME_PATH', 'SJ_HTTP_ADDR', 'SJ_HTTP_CORS', 'SJ_PRODUCTION', 'SJ_SEC_KEY', 'SJ_UDS_DISABLE'])
  assert.equal(env.SJ_HTTP_CORS, 'false')
  assert.equal(env.SJ_API_KEY, 'k')
  assert.equal(env.SJ_HTTP_ADDR, '127.0.0.1:1234')
  assert.equal(env.PATH, '/bin')
})

// 假的 shioaji：參數或環境不對就結束；金鑰是 bad 就模擬登入失敗；否則在 SJ_HTTP_ADDR 開健康檢查
test('sinopac: 開伺服器、等它好、查完關掉；登入失敗與找不到程式都有看得懂的錯誤', { skip: process.platform === 'win32' && '假執行檔是 shell script' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'nestegg-sj-'))
  const bin = join(dir, 'shioaji')
  writeFileSync(bin, `#!/usr/bin/env node
const env = process.env
if (env.SJ_API_KEY === 'bad') { console.error('Login failed: invalid api key'); process.exit(3) }
if (process.argv.slice(2).join(' ') !== 'server start --production --no-open' || env.SJ_CA_PATH || env.SJ_PRODUCTION !== 'true') process.exit(9)
const [host, port] = env.SJ_HTTP_ADDR.split(':')
require('node:http').createServer((q, s) => s.end('{"status":"healthy"}')).listen(+port, host)
`)
  chmodSync(bin, 0o755)
  process.env.SJ_CA_PATH = join(dir, 'mine.pfx') // 使用者自己設的憑證不能被帶進去
  try {
    const { url, stop } = await sinopac.server(bin, creds, dir)
    assert.equal((await (await fetch(`${url}/api/v1/health`)).json()).status, 'healthy')
    stop()
    await new Promise(r => setTimeout(r, 300))
    await assert.rejects(fetch(`${url}/api/v1/health`)) // 查完就關掉
    await assert.rejects(sinopac.server(bin, { ...creds, apiKey: 'bad' }, dir), /登入失敗（代碼 3）：Login failed/)
    await assert.rejects(sinopac.server(join(dir, 'missing'), creds, dir), /無法執行 Shioaji/)
  } finally {
    delete process.env.SJ_CA_PATH
  }
})

// 安裝：下載的壓縮檔解開後的資料夾 → 檢查作業系統、CPU、有沒有執行檔，記下版本
test('sinopac: 安裝時認得對的壓縮檔，拒絕別的作業系統、別的 CPU 與不是 Shioaji 的檔案', async () => {
  const OS = { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform]
  const ARCH = { arm64: 'aarch64', x64: 'x86_64' }[process.arch]
  const BIN = process.platform === 'win32' ? 'shioaji.exe' : 'shioaji'
  const unpacked = files => {
    const dir = mkdtempSync(join(tmpdir(), 'nestegg-unpack-'))
    for (const f of files) writeFileSync(join(dir, f), '')
    return dir
  }
  const ok = await sinopac.sdk.unpack(unpacked([`shioaji-v1.7.7-${OS}-${ARCH}.tar.gz`, BIN]))
  assert.equal(await sinopac.sdk.version(ok), '1.7.7')
  assert.equal(readFileSync(join(ok, 'version.txt'), 'utf8'), '1.7.7')
  const otherOs = OS === 'Windows' ? 'macOS' : 'Windows'
  await assert.rejects(sinopac.sdk.unpack(unpacked([`shioaji-v1.7.7-${otherOs}-x86_64.zip`, 'shioaji.exe', 'shioaji'])), /其他作業系統/)
  if (ARCH === 'x86_64') await assert.rejects(sinopac.sdk.unpack(unpacked([`shioaji-v1.7.7-${OS}-aarch64.tar.gz`, BIN])), /Apple 晶片／ARM/)
  await assert.rejects(sinopac.sdk.unpack(unpacked(['fubon-neo.zip'])), /不是 Shioaji/)
})
