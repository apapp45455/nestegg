// 寵物視窗的位置：記住離哪個角落最近、距離多少，螢幕變了就照同樣的距離重新擺，並夾在可用範圍內。
// 純函式（不碰 Electron），方便測試。area 是螢幕的 workArea（不含選單列、Dock、工作列）。

const clamp = (n, min, max) => Math.max(min, Math.min(n, max)) // 螢幕比視窗小時以左上角為準

// 放開拖曳時：記下水平、垂直各離哪一邊比較近（拖到螢幕外的距離算 0）
export function anchorOf(bounds, area) {
  const left = bounds.x - area.x
  const right = area.x + area.width - (bounds.x + bounds.width)
  const top = bounds.y - area.y
  const bottom = area.y + area.height - (bounds.y + bounds.height)
  return {
    ...(left < right ? { left: Math.max(0, left) } : { right: Math.max(0, right) }),
    ...(top < bottom ? { top: Math.max(0, top) } : { bottom: Math.max(0, bottom) }),
  }
}

// 依 anchor 算出在這個螢幕上的位置，整個視窗一定落在可用範圍內
export function placeAt(anchor, area, size) {
  const x = 'left' in anchor ? area.x + anchor.left : area.x + area.width - size.width - anchor.right
  const y = 'top' in anchor ? area.y + anchor.top : area.y + area.height - size.height - anchor.bottom
  return {
    x: Math.round(clamp(x, area.x, area.x + area.width - size.width)),
    y: Math.round(clamp(y, area.y, area.y + area.height - size.height)),
    ...size,
  }
}
