// Recurring plans: list, add, end and delete. Every change saves the whole list; the main process validates it
// and answers with each plan's count and total so far
const $ = id => document.getElementById(id)
const add = $('add')
const result = $('result')
let current = [] // not `plans`: that name is taken by window.plans from the preload
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
  current = data.plans
  add.elements.start.value ||= today
  $('empty').hidden = current.length > 0
  $('plans').replaceChildren(...current.map((p, i) => {
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
    end.onchange = () => save(current.map((q, j) => (j === i ? { ...q, end: end.value || null } : q)))
    const endLabel = document.createElement('label')
    endLabel.append('結束日期', end)
    const remove = Object.assign(document.createElement('button'), { type: 'button', textContent: '刪除' })
    remove.onclick = () => {
      if (confirm(`刪除「${p.symbol}」的計畫？已經記的 ${p.count} 筆投入會一起從寵物身上拿掉。只是要停扣的話，請改填結束日期。`)) {
        save(current.filter((_, j) => j !== i))
      }
    }
    const controls = Object.assign(document.createElement('div'), { className: 'row' })
    controls.append(endLabel, remove)
    li.append(title, info, controls)
    return li
  }))
}

// On failure nothing is saved: show why and redraw the plans as they are
async function save(next) {
  try {
    render(await window.plans.set(next))
    show('')
    return true
  } catch (e) {
    show(reason(e), 'error')
    render(await window.plans.get())
    return false
  }
}

add.onsubmit = async e => {
  e.preventDefault()
  const plan = Object.fromEntries(new FormData(add))
  if (await save([...current, plan])) {
    add.reset()
    add.elements.start.value = today
  }
}

window.plans.get().then(render)
