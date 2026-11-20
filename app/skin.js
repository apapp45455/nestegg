// The pet's custom look (skin.json), drawn in the appearance window: for each stage that has one, 256 cells (16×16, row
// by row) holding a color or null for transparent, and the cells that are eyes (they blink). Stages without one use the
// default sprite. The file can be edited by hand, so everything is checked before the pet draws it.
export const STAGES = ['egg', 'baby', 'adult']
const NAMES = { egg: '蛋', baby: '幼年', adult: '成年' }
const COLOR = /^#[0-9a-f]{6}$/i

export function parseSkin(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('寵物外觀的格式不對')
  const skin = {}
  for (const stage of STAGES) {
    const drawing = input[stage]
    if (drawing == null) continue
    const { pixels, eyes = [] } = drawing
    if (!Array.isArray(pixels) || pixels.length !== 256 || !pixels.every(c => c === null || COLOR.test(c))) {
      throw new Error(`${NAMES[stage]}的圖要是 16×16 格，每格是 #rrggbb 顏色或空白`)
    }
    if (!pixels.some(Boolean)) throw new Error(`${NAMES[stage]}的圖是空的，畫點東西或按「恢復預設」`)
    if (!Array.isArray(eyes) || !eyes.every(i => Number.isInteger(i) && i >= 0 && i < 256 && pixels[i])) {
      throw new Error(`${NAMES[stage]}的眼睛要標在有顏色的格子上`)
    }
    skin[stage] = { pixels: pixels.map(c => c && c.toLowerCase()), eyes: [...new Set(eyes)].sort((a, b) => a - b) }
  }
  return skin
}
