// Pet window placement: remember the nearest corner and the distance from it, re-place at the same distance when the display changes, and clamp to the usable area.
// Pure functions (no Electron), so they're easy to test. area is the display's workArea (excluding the menu bar, Dock and taskbar).

const clamp = (n, min, max) => Math.max(min, Math.min(n, max)) // If the display is smaller than the window, the top-left corner wins

// On drop: record which horizontal and vertical edge is closer (distance off screen counts as 0)
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

// Compute the position on this display from the anchor; the whole window always lands inside the usable area
export function placeAt(anchor, area, size) {
  const x = 'left' in anchor ? area.x + anchor.left : area.x + area.width - size.width - anchor.right
  const y = 'top' in anchor ? area.y + anchor.top : area.y + area.height - size.height - anchor.bottom
  return {
    x: Math.round(clamp(x, area.x, area.x + area.width - size.width)),
    y: Math.round(clamp(y, area.y, area.y + area.height - size.height)),
    ...size,
  }
}
