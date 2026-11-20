// The default pet: 16×16 pixel art and its colors. Shared by the pet window (pet.js) and the appearance editor
// (appearance.js), which starts a drawing from these.
// 16×16 pixel art. e = top half of an eye (disappears when blinking), E = bottom half
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
// Fur only changes the body colors; it returns to normal with the market and never accumulates
const FUR = {
  normal: {},
  shiny: { y: '#ffe36b', Y: '#ffb340' },
  dull: { y: '#d6caa0', Y: '#b8a67c', p: '#d2a8ac' },
}

// A default sprite as an editable drawing: a color (or null for transparent) per cell, row by row, and the eye cells
const defaultDrawing = stage => {
  const cells = [...SPRITES[stage].join('')]
  return { pixels: cells.map(ch => COLORS[ch] ?? null), eyes: cells.flatMap((ch, i) => (ch === 'e' || ch === 'E' ? [i] : [])) }
}
