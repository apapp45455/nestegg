import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSkin } from './skin.js'

const drawing = (color = '#FFD34D') => {
  const pixels = Array(256).fill(null)
  for (let i = 100; i < 140; i++) pixels[i] = color
  return { pixels, eyes: [118, 118, 117] }
}

test('parseSkin: keeps the stages drawn, lowercases colors, tidies the eye list; other stages use the default', () => {
  const skin = parseSkin({ baby: drawing(), unknown: drawing() })
  assert.deepEqual(Object.keys(skin), ['baby'])
  assert.equal(skin.baby.pixels[100], '#ffd34d')
  assert.deepEqual(skin.baby.eyes, [117, 118])
  assert.deepEqual(parseSkin({}), {})
})

test('parseSkin: a broken file names the problem', () => {
  assert.throws(() => parseSkin([]), /格式不對/)
  assert.throws(() => parseSkin({ egg: { pixels: Array(255).fill(null) } }), /16×16/)
  assert.throws(() => parseSkin({ egg: { pixels: Array(256).fill('red') } }), /#rrggbb/)
  assert.throws(() => parseSkin({ egg: { pixels: Array(256).fill(null) } }), /空的/)
  assert.throws(() => parseSkin({ egg: { ...drawing(), eyes: [0] } }), /眼睛/) // Cell 0 is transparent
})
