// 寵物設定：改了就存，寵物馬上跟著變。數字範圍由引擎（SETTINGS）決定，超出範圍的不存並提示
const form = document.getElementById('settings')
const result = document.getElementById('result')

function render(values) {
  for (const [key, v] of Object.entries(values)) {
    const el = form.elements[key]
    // 設定檔裡手改成選單沒有的週期（例如 10 天）也照樣顯示
    if (el.tagName === 'SELECT' && ![...el.options].some(o => +o.value === v)) el.add(new Option(`每 ${v} 天`, v))
    el.value = v
  }
}

// 存不進去（例如磁碟滿了）就說出來，畫面回到實際存著的設定，不要看起來像已經套用。
// 只用最後一次存檔的結果更新畫面：連續改的時候，前一次較晚回來的結果會把剛改的欄位蓋回舊值
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
  // 體型門檻一級比一級高（引擎也會檢查；這裡先擋下，告訴你哪一格要改）
  levels.forEach((el, i) => el.setCustomValidity(i && +el.value <= +levels[i - 1].value ? `要比 Lv${i + 1} 的 ${levels[i - 1].value} 萬元高` : ''))
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
