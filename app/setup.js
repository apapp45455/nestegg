const $ = id => document.getElementById(id)
const form = $('connect')
const result = $('result')
let certPath = ''

function show(text, kind = '') {
  result.textContent = text
  result.className = kind
}

async function render() {
  const { ok: s } = await window.fubon.status()
  $('sdk-status').textContent = s.sdk ? `✓ 已安裝 v${s.sdk}` : '尚未安裝'
  $('step-sdk').classList.toggle('done', !!s.sdk)
  $('step-connect').classList.toggle('done', s.connected)
  form.hidden = s.connected
  $('connected').hidden = !s.connected
  $('connected-info').textContent = s.connected ? `✓ 已連線 · 從 ${s.since} 開始匯入 · 上次同步 ${s.lastSync}` : ''
  $('paused').hidden = !s.paused
  $('paused').textContent = s.paused ? `自動同步已暫停：${s.paused}\n確認問題後按「立即同步」會恢復。` : ''
  form.elements.since.max = s.today
  form.elements.since.value ||= new Date(Date.parse(s.today) - 365 * 864e5).toISOString().slice(0, 10)
}

// 按鈕在等待時鎖住並換字，避免重複送出
async function busy(button, label, fn) {
  const text = button.textContent
  button.disabled = true
  button.textContent = label
  try {
    await fn()
  } finally {
    button.disabled = false
    button.textContent = text
  }
}

function report({ ok, error }) {
  if (error) return show(error, 'error')
  const warn = ok.warnings.length ? `\n有 ${ok.warnings.length} 段期間查詢失敗，例如 ${ok.warnings[0]}` : ''
  show(`同步完成：${ok.accounts} 個證券帳戶，新增 ${ok.added} 筆紀錄。${warn}`, 'success')
}

$('install').onclick = () => busy($('install'), '安裝中…', async () => {
  const { ok, error } = await window.fubon.installSdk()
  if (error) $('sdk-status').textContent = `⚠️ ${error}`
  else if (ok) await render()
})

$('pick-cert').onclick = async () => {
  const { ok } = await window.fubon.pickCert()
  if (!ok) return
  certPath = ok
  $('cert-name').textContent = ok.split(/[\\/]/).pop()
}

form.onsubmit = e => {
  e.preventDefault()
  busy(form.querySelector('[type=submit]'), '連線中…', async () => {
    show('正在登入富邦並查詢成交紀錄，第一次可能要一分鐘…')
    const f = Object.fromEntries(new FormData(form))
    const res = await window.fubon.connect({ id: f.personalId, apiKey: f.apiKey, certPath, certPass: f.certPass, since: f.since })
    report(res)
    if (res.ok) {
      form.reset()
      certPath = ''
      $('cert-name').textContent = '尚未選擇'
      await render()
    }
  })
}

$('sync').onclick = () => busy($('sync'), '同步中…', async () => {
  show('正在同步…')
  report(await window.fubon.sync())
  await render()
})

$('disconnect').onclick = async () => {
  if (!confirm('確定要清除儲存的富邦金鑰嗎？之後要重新設定才能同步。')) return
  await window.fubon.disconnect()
  show('已清除儲存的金鑰。已同步進帳本的紀錄會保留。')
  await render()
}

render()
