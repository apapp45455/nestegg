import { test } from 'node:test'
import assert from 'node:assert/strict'
import { anchorOf, placeAt } from './placement.js'

const size = { width: 200, height: 300 }
const big = { x: 0, y: 25, width: 1920, height: 1055 } // 外接螢幕
const laptop = { x: 0, y: 33, width: 1512, height: 949 } // MacBook 內建螢幕

test('placement: 換到比較小的螢幕，右下角的寵物還在右下角、不會跑出畫面', () => {
  const anchor = { right: 40, bottom: 0 }
  assert.deepEqual(placeAt(anchor, big, size), { x: 1680, y: 780, ...size })
  assert.deepEqual(placeAt(anchor, laptop, size), { x: 1272, y: 682, ...size })
})

test('placement: 放開時記住最近的角落；拖出螢幕外的拉回來', () => {
  const nearTopLeft = anchorOf({ x: 100, y: 133, ...size }, laptop)
  assert.deepEqual(nearTopLeft, { left: 100, top: 100 })
  assert.deepEqual(placeAt(nearTopLeft, big, size), { x: 100, y: 125, ...size })

  const offBottom = { x: 1272, y: 783, ...size } // 實際遇到的狀況：下緣超出螢幕 101px
  const anchor = anchorOf(offBottom, laptop)
  assert.deepEqual(anchor, { right: 40, bottom: 0 })
  assert.deepEqual(placeAt(anchor, laptop, size), { x: 1272, y: 682, ...size })
})

test('placement: 螢幕比視窗還小時至少貼齊左上角', () => {
  assert.deepEqual(placeAt({ right: 0, bottom: 0 }, { x: 0, y: 0, width: 150, height: 200 }, size), { x: 0, y: 0, ...size })
})
