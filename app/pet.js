// 16×16 像素圖。e = 眼睛上半（眨眼時消失），E = 眼睛下半
const SPRITES = {
  egg: [
    '................',
    '......oooo......',
    '.....owwwwo.....',
    '....owwwwwwo....',
    '...owwsswwwwo...',
    '...owwsswwwwo...',
    '..owwwwwwwsswo..',
    '..owwwwwwwsswo..',
    '..owwswwwwwwwo..',
    '..owwwwwwwwwwo..',
    '..owwwwwwsswwo..',
    '..owwwwwwsswwo..',
    '...owwwwwwwwo...',
    '....owwwwwwo....',
    '.....oooooo.....',
    '................',
  ],
  baby: [
    '................',
    '................',
    '........o.......',
    '.......oyo......',
    '....oooooooo....',
    '...oyyyyyyyyo...',
    '..oyyyyyyyyyyo..',
    '..oyyeyyyyeyyo..',
    '..oyyEyyyyEyyo..',
    '..opyyybbyyypo..',
    '..oyyyyyyyyyyo..',
    '..oyyyyyyyyyyo..',
    '...oyyyyyyyyo...',
    '....oooooooo....',
    '.....b....b.....',
    '................',
  ],
  adult: [
    '.......oo.......',
    '......oyyo......',
    '...oooooooooo...',
    '..oyyyyyyyyyyo..',
    '.oyyyyyyyyyyyyo.',
    '.oyyyeyyyyeyyyo.',
    '.oyyyEyyyyEyyyo.',
    '.opyyyybbyyyypo.',
    'oYyyyyyyyyyyyyYo',
    'oYYyyywwwwyyyYYo',
    'oYYyywwwwwwyyYYo',
    '.oYyywwwwwwyyYo.',
    '..oyyywwwwyyyo..',
    '...oooooooooo...',
    '.....b....b.....',
    '....bb....bb....',
  ],
}
SPRITES.none = SPRITES.egg

const COLORS = {
  o: '#3b2a1a', e: '#3b2a1a', E: '#3b2a1a',
  w: '#fff4dc', s: '#e8b866',
  y: '#ffd34d', Y: '#f0a830', b: '#ff8a3d', p: '#ff9eae',
}
// 毛色只換身體顏色；行情回來就恢復，不會累積
const FUR = {
  normal: {},
  shiny: { y: '#ffe36b', Y: '#ffb340' },
  dull: { y: '#d6caa0', Y: '#b8a67c', p: '#d2a8ac' },
}
const SPARKLES = [[1, 3], [14, 2], [15, 9], [0, 12]] // 發亮時在這些空白格閃爍
const TEAR = '#5aa9ff'

// 天空：16×10 像素，畫在寵物頭上
const SUN = [
  '........r.......',
  '....r...r...r...',
  '.....r.uuu.r....',
  '......uuuuu.....',
  '..rr.uuuuuuu.rr.',
  '......uuuuu.....',
  '.....r.uuu.r....',
  '....r...r...r...',
  '........r.......',
  '................',
]
const CLOUD = [
  '................',
  '.....kkkk.......',
  '...kkcccckk.....',
  '..kcccccccckk...',
  '.kcccccccccccck.',
  '.kkkkkkkkkkkkkk.',
]
const SKY_COLORS = { u: '#ffcf33', r: '#ff9f1c', k: '#8a9bb0', c: '#e3e9f0' }
const STORM_COLORS = { k: '#4d5b6e', c: '#8796a8' }
const LABELS = {
  weather: { sunny: '☀️ 晴', rain: '🌧️ 雨', typhoon: '🌀 颱風' },
  mood: { happy: '開心', calm: '平靜', sad: '難過' },
  fur: { shiny: '發亮', normal: '普通', dull: '黯淡' },
}
const STAGE_NAMES = { egg: '蛋', baby: '幼年', adult: '成年' }

const pet = document.getElementById('pet')
const sky = document.getElementById('sky')
const bubble = document.getElementById('bubble')
const hunger = document.getElementById('hunger')
const ctx = pet.getContext('2d')
const skyCtx = sky.getContext('2d')
let state = { stage: 'none', size: 1, satiety: 3 }
let blink = false
let tick = 0 // 動畫格：雨滴、閃光
let bubbleTimer

const px = (c, x, y, color) => { c.fillStyle = color; c.fillRect(x, y, 1, 1) }
const paint = (c, rows, colors) => rows.forEach((row, y) => [...row].forEach((ch, x) => colors[ch] && px(c, x, y, colors[ch])))

// 表情：眼睛是上下兩格（e 在上、E 在下）
function drawFace(rows, colors) {
  rows.forEach((row, y) => [...row].forEach((ch, x) => {
    if (ch !== 'E') return
    if (state.mood === 'happy') { // ^ ^ 瞇眼笑
      px(ctx, x, y, colors.y)
      px(ctx, x - 1, y, colors.o)
      px(ctx, x + 1, y, colors.o)
    } else if (state.mood === 'sad') { // 眼睛垂下，左眼一滴淚
      px(ctx, x, y - 1, colors.y)
      if (x < 8) px(ctx, x, y + 1, TEAR)
    } else if (blink) {
      px(ctx, x, y - 1, colors.y)
    }
  }))
}

function drawSky() {
  sky.hidden = !state.weather
  if (!state.weather) return
  skyCtx.clearRect(0, 0, 16, 10)
  if (state.weather === 'sunny') return paint(skyCtx, SUN, SKY_COLORS)
  const storm = state.weather === 'typhoon'
  paint(skyCtx, CLOUD, storm ? { ...SKY_COLORS, ...STORM_COLORS } : SKY_COLORS)
  // 雨滴往下掉、每欄錯開；颱風更密而且斜著下
  const cols = storm ? [2, 4, 6, 8, 10, 12, 14] : [4, 8, 12]
  cols.forEach((x, i) => {
    const y = 6 + ((tick + i * 3) % 4)
    px(skyCtx, storm ? x - ((y - 6) >> 1) : x, y, TEAR)
  })
}

function draw() {
  const hatched = state.stage === 'baby' || state.stage === 'adult'
  const colors = { ...COLORS, ...(hatched && FUR[state.fur]) }
  const rows = SPRITES[state.stage]
  ctx.clearRect(0, 0, 16, 16)
  paint(ctx, rows, colors)
  if (hatched) drawFace(rows, colors)
  if (hatched && state.fur === 'shiny' && (tick >> 1) % 2) {
    for (const [x, y] of SPARKLES) if (rows[y][x] === '.') px(ctx, x, y, '#ffb703') // 金色：深淺桌布上都看得到
  }
  pet.style.width = pet.style.height = `${16 * (3 + state.size)}px` // Lv1..5 → 每像素 4..8px
  pet.className = [state.stage, state.satiety < 3 && 'hungry', hatched && state.mood, state.weather].filter(Boolean).join(' ')
  hunger.hidden = state.satiety >= 3
  drawSky()
}

function say(text, ms = 5000) {
  bubble.textContent = text
  bubble.hidden = false
  clearTimeout(bubbleTimer)
  if (ms) bubbleTimer = setTimeout(() => (bubble.hidden = true), ms)
}

function status() {
  if (state.stage === 'none') return '還沒有交易紀錄\n按右鍵 → 匯入 CSV'
  const bowls = '🍚'.repeat(state.satiety) + '・'.repeat(3 - state.satiety)
  const lines = [`${STAGE_NAMES[state.stage]} · 第 ${state.age} 天 · Lv${state.size}`, `飽足 ${bowls}`]
  if (state.mood && state.stage !== 'egg') lines.push(`心情${LABELS.mood[state.mood]} · 毛色${LABELS.fur[state.fur]}`)
  if (state.weather) {
    const d = state.marketDate
    const pct = `${state.indexChange >= 0 ? '+' : ''}${state.indexChange.toFixed(2)}%`
    lines.push(`${LABELS.weather[state.weather]} · 加權 ${pct} · ${+d.slice(5, 7)}/${+d.slice(8)}`)
  }
  return lines.join('\n')
}

window.nestegg.onState(s => {
  if (s.error) return say(`⚠️ 帳本讀取失敗\n${s.error}`, 0)
  // 錯誤排除了、或「還沒有交易紀錄」的提示已經不成立，就收起氣泡
  if (bubble.textContent.startsWith('⚠️') || (state.stage === 'none' && s.stage !== 'none')) bubble.hidden = true
  const first = state.age === undefined
  state = s
  draw()
  if (first && s.stage === 'none') say(status(), 0)
})

window.nestegg.onSay(text => say(text ?? status(), 8000)) // null = 顯示目前狀態

// 拖曳 vs 點擊：移動超過 3px 才算拖曳
let grab = null
pet.addEventListener('pointerdown', e => {
  if (e.button !== 0) return
  grab = { x: e.clientX, y: e.clientY, sx: e.screenX, sy: e.screenY, moved: false }
  pet.setPointerCapture(e.pointerId)
})
pet.addEventListener('pointermove', e => {
  if (!grab) return
  if (!(e.buttons & 1)) return (grab = null) // 漏接 pointerup 時別讓寵物黏在游標上
  if (Math.abs(e.screenX - grab.sx) + Math.abs(e.screenY - grab.sy) > 3) grab.moved = true
  if (grab.moved) window.nestegg.moveTo(e.screenX - grab.x, e.screenY - grab.y)
})
pet.addEventListener('pointerup', () => {
  if (grab && !grab.moved) bubble.hidden ? say(status()) : (bubble.hidden = true)
  if (grab?.moved) window.nestegg.drop()
  grab = null
})

// 只有滑鼠在寵物上（或拖曳中）才接收點擊，其餘透明區域穿透
let solid = false
document.addEventListener('mousemove', e => {
  const over = !!grab || e.target === pet
  if (over !== solid) window.nestegg.setSolid((solid = over))
})

setInterval(() => {
  if (state.stage === 'egg' || state.stage === 'none' || state.mood === 'happy') return
  blink = true
  draw()
  setTimeout(() => { blink = false; draw() }, 150)
}, 4000)

setInterval(() => {
  tick++
  if (state.weather === 'rain' || state.weather === 'typhoon' || state.fur === 'shiny') draw()
}, 300)

draw()
