// 寵物設定：改了就存，寵物馬上跟著變。數字範圍由引擎（SETTINGS）決定，超出範圍的不存並提示
const form = document.getElementById('settings')

function render(values) {
  for (const [key, v] of Object.entries(values)) {
    const el = form.elements[key]
    // 設定檔裡手改成選單沒有的週期（例如 10 天）也照樣顯示
    if (el.tagName === 'SELECT' && ![...el.options].some(o => +o.value === v)) el.add(new Option(`每 ${v} 天`, v))
    el.value = v
  }
}

const save = async input => render(await window.petSettings.set(input))

form.addEventListener('change', () => {
  if (!form.checkValidity()) return form.reportValidity()
  save(Object.fromEntries([...new FormData(form)].map(([key, v]) => [key, v === '' ? undefined : Number(v)])))
})
document.getElementById('reset').onclick = () => save({})

window.petSettings.get().then(({ values, limits }) => {
  for (const [key, { min, max, step }] of Object.entries(limits)) {
    const el = form.elements[key]
    if (el.tagName === 'INPUT') Object.assign(el, { min, max, step, required: true })
  }
  render(values)
})
