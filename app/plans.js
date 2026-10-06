// Recurring plans and the sells of what they bought: list, add, end and delete. Every change saves the whole file; the
// main process validates it and answers with each plan's count and total so far
const $ = id => document.getElementById(id)
const add = $('add')
const sell = $('sell')
const result = $('result')
let current = { plans: [], sells: [] } // not `plans`: that name is taken by window.plans from the preload
let today = ''

const money = n => `NT$${n.toLocaleString('en-US')}`
// ipcRenderer.invoke wraps errors as "Error invoking remote method 'plans:set': Error: …"; show only the message
const reason = e => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

function show(text, kind = '') {
  result.textContent = text
  result.className = kind
}

function render(data) {
  today = data.today
  current = { plans: data.plans, sells: data.sells }
  add.elements.start.value ||= today
  sell.elements.date.value ||= today
  sell.elements.date.max = today
  $('empty').hidden = current.plans.length > 0
  $('plans').replaceChildren(...current.plans.map((p, i) => {
    const li = document.createElement('li')
    const ended = p.end && p.end < today
    const title = Object.assign(document.createElement('div'), {
      className: 'title',
      textContent: `${p.symbol} · 每月 ${p.day} 日 · ${money(p.amount)}`,
    })
    const info = Object.assign(document.createElement('div'), {
      className: ended ? 'ended' : 'note',
      textContent: `${p.start} 起${p.end ? `，到 ${p.end}` : ''} · 已記 ${p.count} 筆，共 ${money(p.total)}${ended ? '（已結束）' : ''}`,
    })
    // Ending a plan keeps its past contributions; deleting it removes them
    const end = Object.assign(document.createElement('input'), { type: 'date', value: p.end ?? '', min: p.start })
    end.onchange = () => save({ ...current, plans: current.plans.map((q, j) => (j === i ? { ...q, end: end.value || null } : q)) })
    const endLabel = document.createElement('label')
    endLabel.append('結束日期', end)
    const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: '刪除' })
    remove.onclick = () => {
      if (confirm(`刪除「${p.symbol}」的計畫？已經記的 ${p.count} 筆投入會一起從寵物身上拿掉。只是要停扣的話，請改填結束日期。`)) {
        save({ ...current, plans: current.plans.filter((_, j) => j !== i) })
      }
    }
    const controls = Object.assign(document.createElement('div'), { className: 'row' })
    controls.append(endLabel, remove)
    li.append(title, info, controls)
    return li
  }))
  $('symbols').replaceChildren(...[...new Set(current.plans.map(p => p.symbol))].map(symbol => new Option(symbol)))
  $('sells').replaceChildren(...current.sells.map((x, i) => {
    const li = document.createElement('li')
    const title = Object.assign(document.createElement('div'), {
      className: 'title',
      textContent: `${x.symbol} · ${x.date} 賣出 ${x.shares} 股`,
    })
    const info = Object.assign(document.createElement('div'), {
      className: 'note',
      textContent: `賣出前持有 ${x.held} 股，這一檔的本金扣掉 ${Math.round((x.shares / x.held) * 100)}%`,
    })
    const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: '刪除' })
    remove.onclick = () => {
      if (confirm(`刪除這筆「${x.symbol}」的賣出？扣掉的本金會加回寵物身上。`)) save({ ...current, sells: current.sells.filter((_, j) => j !== i) })
    }
    const controls = Object.assign(document.createElement('div'), { className: 'row' })
    controls.append(remove)
    li.append(title, info, controls)
    return li
  }))
}

// A plans.json broken by hand can't be read: say why instead of staying blank. Adding a plan still works and
// replaces the broken file, so the message says so
async function load() {
  try {
    render(await window.plans.get())
  } catch (e) {
    show(`${reason(e)}。在這裡新增計畫會取代這個壞掉的檔案。`, 'error')
  }
}

// On failure nothing is saved: show why and redraw the plans as they are
async function save(next) {
  try {
    render(await window.plans.set(next))
    show('')
    return true
  } catch (e) {
    show(reason(e), 'error')
    await load()
    return false
  }
}

add.onsubmit = async e => {
  e.preventDefault()
  const plan = Object.fromEntries(new FormData(add))
  if (await save({ ...current, plans: [...current.plans, plan] })) {
    add.reset()
    add.elements.start.value = today
  }
}

sell.onsubmit = async e => {
  e.preventDefault()
  if (await save({ ...current, sells: [...current.sells, Object.fromEntries(new FormData(sell))] })) {
    sell.reset()
    sell.elements.date.value = today
  }
}

load()
