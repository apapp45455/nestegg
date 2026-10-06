// Setup wizard: a page without data-broker is the broker picker; with it, it's that broker's setup page (field names are the fields submitted)
const $ = id => document.getElementById(id)
const id = document.body.dataset.broker

async function renderList() {
  const { ok: brokers } = await window.broker.list()
  $('brokers').replaceChildren(...brokers.map(b => {
    const li = document.createElement('li')
    const a = Object.assign(document.createElement('a'), { href: `setup-${b.id}.html`, textContent: b.name })
    const note = Object.assign(document.createElement('span'), { className: 'note' })
    note.textContent = b.paused ? '⚠️ 自動同步已暫停' : b.connected ? `✓ 已連線 · 上次同步 ${b.lastSync}` : '尚未設定'
    a.append(note)
    li.append(a)
    return li
  }))
}

const form = $('connect')
const result = $('result')
let certPath = ''
let name = ''

function show(text, kind = '') {
  result.textContent = text
  result.className = kind
}

async function render() {
  const { ok: s } = await window.broker.status(id)
  name = s.name
  if ($('sdk-status')) {
    $('sdk-status').textContent = s.sdk ? `✓ 已安裝 v${s.sdk}` : '尚未安裝'
    $('step-sdk').classList.toggle('done', !!s.sdk)
  }
  $('step-connect').classList.toggle('done', s.connected)
  form.hidden = s.connected
  if ($('history')) $('history').elements.since.max = s.today
  $('connected').hidden = !s.connected
  $('connected-info').textContent = s.connected ? `✓ 已連線 · 從 ${s.since} 開始匯入 · 上次同步 ${s.lastSync}` : ''
  $('paused').hidden = !s.paused
  $('paused').textContent = s.paused ? `自動同步已暫停：${s.paused}\n確認問題後按「立即同步」會恢復。` : ''
  form.elements.since.max = s.today
  form.elements.since.value ||= new Date(Date.parse(s.today) - 365 * 864e5).toISOString().slice(0, 10)
}

// Disable the button and change its label while waiting, to prevent double submits
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
  const warn = ok.warnings.length ? `\n有 ${ok.warnings.length} 則提醒：\n${ok.warnings.join('\n')}` : '' // For Fubon these are periods whose query failed; for Sinopac, skipped records
  show(`同步完成：${ok.accounts} 個證券帳戶，新增 ${ok.added} 筆紀錄。${warn}`, 'success')
}

function initBrokerPage() {
  $('install')?.addEventListener('click', () => busy($('install'), '安裝中…', async () => {
    const { ok, error } = await window.broker.installSdk(id)
    if (error) $('sdk-status').textContent = `⚠️ ${error}`
    else if (ok) await render()
  }))

  $('pick-cert')?.addEventListener('click', async () => {
    const { ok } = await window.broker.pickCert(id)
    if (!ok) return
    certPath = ok
    $('cert-name').textContent = ok.split(/[\\/]/).pop()
  })

  form.onsubmit = e => {
    e.preventDefault()
    busy(form.querySelector('[type=submit]'), '連線中…', async () => {
      show(`正在登入${name}並查詢成交紀錄，第一次可能要一分鐘…`)
      const res = await window.broker.connect(id, { ...Object.fromEntries(new FormData(form)), certPath })
      report(res)
      if (res.ok) {
        form.reset()
        certPath = ''
        if ($('cert-name')) $('cert-name').textContent = '尚未選擇'
        await render()
      }
    })
  }

  // Fubon: import the history later, logging in with the saved keys (only the history key and start date are entered)
  if ($('history')) $('history').onsubmit = e => {
    e.preventDefault()
    const history = $('history')
    busy(history.querySelector('[type=submit]'), '匯入中…', async () => {
      show('正在匯入過去的成交紀錄，期間長的話要幾分鐘…')
      const res = await window.broker.connect(id, { ...Object.fromEntries(new FormData(history)), keepKeys: true })
      report(res)
      if (res.ok) {
        history.reset()
        await render()
      }
    })
  }

  $('sync').onclick = () => busy($('sync'), '同步中…', async () => {
    show('正在同步…')
    report(await window.broker.sync(id))
    await render()
  })

  $('disconnect').onclick = async () => {
    if (!confirm(`確定要清除儲存的${name}金鑰嗎？之後要重新設定才能同步。`)) return
    const { error } = await window.broker.disconnect(id)
    if (error) return show(error, 'error') // For example, refused during a sync: the keys are still there, so don't claim they were cleared
    show('已清除儲存的金鑰。已同步進帳本的紀錄會保留。')
    await render()
  }

  render()
}

if (id) initBrokerPage()
else renderList()
