// Pet settings: changes save immediately and the pet updates right away. The engine (SETTINGS) defines the ranges; out-of-range values aren't saved and the user is told why
const form = document.getElementById('settings')
const result = document.getElementById('result')

function render(values) {
  for (const [key, v] of Object.entries(values)) {
    const el = form.elements[key]
    // Still show a period that isn't in the menu (for example, 10 days set by hand in the file)
    if (el.tagName === 'SELECT' && ![...el.options].some(o => +o.value === v)) el.add(new Option(`每 ${v} 天`, v))
    if (el.type === 'checkbox') el.checked = v
    else el.value = v
  }
}

// If saving fails (for example, the disk is full), say so and show the settings actually stored, so it never looks applied when it isn't.
// Only the latest save's result updates the form: with rapid edits, an earlier result arriving late would reset fields the user just changed
let latest = 0
async function save(input) {
  const mine = ++latest
  try {
    const values = await window.petSettings.set(input)
    if (mine !== latest) return
    render(values)
    result.hidden = true
  } catch (e) {
    if (mine !== latest) return
    Object.assign(result, { hidden: false, textContent: `存檔失敗，畫面已回到目前的設定：${e.message}` })
    render((await window.petSettings.get()).values)
  }
}

const levels = ['lv2', 'lv3', 'lv4', 'lv5'].map(key => form.elements[key])

form.addEventListener('change', () => {
  // Each size threshold must be higher than the last (the engine checks too; blocking here tells the user which field to fix)
  levels.forEach((el, i) => el.setCustomValidity(i && +el.value <= +levels[i - 1].value ? `要比 Lv${i + 1} 的 ${levels[i - 1].value} 萬元高` : ''))
  if (!form.checkValidity()) return form.reportValidity()
  const values = Object.fromEntries([...new FormData(form)].filter(([key]) => form.elements[key].type !== 'checkbox').map(([key, v]) => [key, v === '' ? undefined : Number(v)]))
  for (const el of form.querySelectorAll('input[type=checkbox]')) values[el.name] = el.checked
  save(values)
})
document.getElementById('reset').onclick = () => save({})

window.petSettings.get().then(({ values, limits }) => {
  for (const [key, { min, max, step }] of Object.entries(limits)) {
    const el = form.elements[key]
    if (el.tagName === 'INPUT' && el.type !== 'checkbox') Object.assign(el, { min, max, step, required: true })
  }
  render(values)
})
