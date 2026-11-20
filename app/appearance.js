// Appearance editor: draw each stage on a 16×16 board, or upload an image that's shrunk to 16×16. Saving sends the
// custom stages to the main process, which checks them (see skin.js) and passes them to the pet
const $ = id => document.getElementById(id)
const STAGES = ['egg', 'baby', 'adult']
const CELL = 20 // Board pixels per cell
const board = $('board')
const boardCtx = board.getContext('2d')
const previewCtx = $('preview').getContext('2d')
const color = $('color')
let stage = 'baby'
let tool = 'paint'
// Per stage: the drawing being edited, and whether it's custom (saved or edited) or the default sprite
const drafts = Object.fromEntries(STAGES.map(s => [s, { ...defaultDrawing(s), custom: false }]))

// ipcRenderer.invoke wraps errors as "Error invoking remote method 'skin:set': Error: …"; show only the message
const reason = e => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
function show(text, kind = '') {
  $('result').textContent = text
  $('result').className = kind
}
const changed = dirty => ($('dirty').hidden = !dirty)

function render() {
  const { pixels, eyes } = drafts[stage]
  for (let i = 0; i < 256; i++) { // Transparent cells show a checkerboard
    boardCtx.fillStyle = pixels[i] ?? (((i % 16) + (i >> 4)) % 2 ? '#e9e4da' : '#f6f2ea')
    boardCtx.fillRect((i % 16) * CELL, (i >> 4) * CELL, CELL, CELL)
  }
  boardCtx.strokeStyle = 'rgba(0, 0, 0, .08)'
  for (let k = 1; k < 16; k++) {
    boardCtx.beginPath()
    boardCtx.moveTo(k * CELL + .5, 0)
    boardCtx.lineTo(k * CELL + .5, 16 * CELL)
    boardCtx.moveTo(0, k * CELL + .5)
    boardCtx.lineTo(16 * CELL, k * CELL + .5)
    boardCtx.stroke()
  }
  for (const i of eyes) { // Eye cells: a ring that shows on any color
    const [x, y] = [(i % 16) * CELL + CELL / 2, (i >> 4) * CELL + CELL / 2]
    for (const [style, width] of [['#000', 4], ['#fff', 2]]) {
      boardCtx.beginPath()
      boardCtx.arc(x, y, CELL / 4, 0, Math.PI * 2)
      boardCtx.strokeStyle = style
      boardCtx.lineWidth = width
      boardCtx.stroke()
    }
  }
  boardCtx.lineWidth = 1
  previewCtx.clearRect(0, 0, 16, 16)
  pixels.forEach((c, i) => {
    if (!c) return
    previewCtx.fillStyle = c
    previewCtx.fillRect(i % 16, i >> 4, 1, 1)
  })
  for (const b of document.querySelectorAll('[data-stage]')) {
    b.classList.toggle('active', b.dataset.stage === stage)
    b.textContent = `${{ egg: '蛋', baby: '幼年', adult: '成年' }[b.dataset.stage]}${drafts[b.dataset.stage].custom ? '（自訂）' : ''}`
  }
  for (const b of document.querySelectorAll('[data-tool]')) b.setAttribute('aria-pressed', b.dataset.tool === tool)
  // The colors this drawing uses, to pick again with one click
  $('swatches').replaceChildren(...[...new Set(pixels.filter(Boolean))].slice(0, 24).map(c => {
    const b = Object.assign(document.createElement('button'), { type: 'button', title: c })
    b.style.background = c
    b.onclick = () => { color.value = c; tool = 'paint'; render() }
    return b
  }))
}

// Replace the current stage's drawing (after an upload, "from default" or "clear")
function replace(drawing, custom = true) {
  drafts[stage] = { pixels: [...drawing.pixels], eyes: [...drawing.eyes], custom }
  changed(true)
  render()
}

const cellAt = e => {
  const r = board.getBoundingClientRect()
  const x = Math.floor(((e.clientX - r.left) / r.width) * 16)
  const y = Math.floor(((e.clientY - r.top) / r.height) * 16)
  return x >= 0 && x < 16 && y >= 0 && y < 16 ? y * 16 + x : -1
}

// first: the cell under pointerdown; eyes and the color picker only act on that one, painting follows the drag
function apply(i, first) {
  const d = drafts[stage]
  if (i < 0) return
  if (tool === 'pick') {
    if (first && d.pixels[i]) color.value = d.pixels[i]
    tool = 'paint'
    return render()
  }
  if (tool === 'eye') {
    if (!first || !d.pixels[i]) return
    d.eyes = d.eyes.includes(i) ? d.eyes.filter(j => j !== i) : [...d.eyes, i]
  } else {
    d.pixels[i] = tool === 'erase' ? null : color.value
    if (tool === 'erase') d.eyes = d.eyes.filter(j => j !== i)
  }
  d.custom = true
  changed(true)
  render()
}

let painting = false
board.addEventListener('pointerdown', e => {
  painting = true
  board.setPointerCapture(e.pointerId)
  apply(cellAt(e), true)
})
board.addEventListener('pointermove', e => painting && apply(cellAt(e), false))
board.addEventListener('pointerup', () => (painting = false))

const hex = (r, g, b) => `#${[r, g, b].map(v => v.toString(16).padStart(2, '0')).join('')}`
const near = (data, o, [r, g, b]) => (data[o] - r) ** 2 + (data[o + 1] - g) ** 2 + (data[o + 2] - b) ** 2 < 60 ** 2

// An image becomes a 16×16 drawing: the empty border is trimmed (transparent pixels, or, for an image without
// transparency, the color of its corner), the rest is shrunk to fit standing on the bottom row, and then the background
// cells connected to the edges become transparent
async function compressImage(blob, removeBg) {
  const img = await createImageBitmap(blob)
  const scale = Math.min(1, 256 / Math.max(img.width, img.height)) // Work on at most 256px: enough to find the border
  const w = Math.max(1, Math.round(img.width * scale))
  const h = Math.max(1, Math.round(img.height * scale))
  const work = new OffscreenCanvas(w, h)
  const workCtx = work.getContext('2d')
  workCtx.drawImage(img, 0, 0, w, h)
  const data = workCtx.getImageData(0, 0, w, h).data
  let opaque = true
  for (let o = 3; o < data.length; o += 4) if (data[o] < 128) { opaque = false; break }
  const corner = [data[0], data[1], data[2]]
  const background = o => data[o + 3] < 128 || (removeBg && opaque && near(data, o, corner))
  let [x0, y0, x1, y1] = [w, h, -1, -1]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (background((y * w + x) * 4)) continue
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y)
    }
  }
  if (x1 < 0) throw new Error('圖片裡找不到圖案（整張都是背景）')
  const [bw, bh] = [x1 - x0 + 1, y1 - y0 + 1]
  const fit = 16 / Math.max(bw, bh)
  const [tw, th] = [Math.max(1, Math.round(bw * fit)), Math.max(1, Math.round(bh * fit))]
  const out = new OffscreenCanvas(16, 16)
  const outCtx = out.getContext('2d')
  outCtx.imageSmoothingQuality = 'high'
  outCtx.drawImage(work, x0, y0, bw, bh, Math.floor((16 - tw) / 2), 16 - th, tw, th)
  const px = outCtx.getImageData(0, 0, 16, 16).data
  const pixels = Array.from({ length: 256 }, (_, i) => (px[i * 4 + 3] < 128 ? null : hex(px[i * 4], px[i * 4 + 1], px[i * 4 + 2])))
  if (removeBg && opaque) {
    // Flood from the edges through transparent and background-colored cells; the subject's own light parts stay
    const seen = new Set()
    const queue = [...Array(256).keys()].filter(i => i < 16 || i >= 240 || i % 16 === 0 || i % 16 === 15)
    while (queue.length) {
      const i = queue.pop()
      if (seen.has(i)) continue
      seen.add(i)
      if (pixels[i] && !near(px, i * 4, corner)) continue
      pixels[i] = null
      for (const j of [i - 16, i + 16, i % 16 ? i - 1 : -1, i % 16 < 15 ? i + 1 : -1]) if (j >= 0 && j < 256) queue.push(j)
    }
  }
  if (!pixels.some(Boolean)) throw new Error('縮小後沒有留下任何格子，試試關掉「自動去背」')
  return { pixels, eyes: [] }
}

for (const b of document.querySelectorAll('[data-stage]')) b.onclick = () => { stage = b.dataset.stage; render() }
for (const b of document.querySelectorAll('[data-tool]')) b.onclick = () => { tool = b.dataset.tool; render() }
color.oninput = () => { tool = 'paint'; render() }

$('upload').onchange = async e => {
  const file = e.target.files[0]
  e.target.value = '' // Choosing the same file again still triggers
  if (!file) return
  try {
    replace(await compressImage(file, $('removeBg').checked))
    show('已經把圖片縮成 16×16，可以再用畫筆修一修。用「眼睛」標出眼睛，寵物就會眨眼。記得按「儲存」。')
  } catch (err) {
    show(`這張圖片沒辦法用：${err.message}`, 'error')
  }
}
$('fromDefault').onclick = () => replace(defaultDrawing(stage))
$('clear').onclick = () => replace({ pixels: Array(256).fill(null), eyes: [] })
$('reset').onclick = () => {
  replace(defaultDrawing(stage), false)
  show('這個階段改回預設外觀，按「儲存」生效。')
}

$('save').onclick = async () => {
  const skin = Object.fromEntries(STAGES.filter(s => drafts[s].custom).map(s => [s, { pixels: drafts[s].pixels, eyes: drafts[s].eyes }]))
  try {
    await window.appearance.set(skin)
    changed(false)
    show('已經儲存，寵物換上新外觀了。', 'success')
  } catch (e) {
    show(reason(e), 'error')
  }
}

window.appearance.get().then(skin => {
  for (const s of STAGES) if (skin[s]) drafts[s] = { ...skin[s], custom: true }
  render()
})
render()
