/**
 * 生成扩展图标（无第三方依赖，直接手写 PNG）。
 * 画法：品牌色圆角方块 + 白色向上箭头（投递/上升）。4x 超采样做抗锯齿。
 *
 *   node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT_DIR = join(HERE, '..', 'icons')
const SIZES = [16, 48, 128]
const SS = 4 // 超采样倍数

const BRAND = [0x00, 0xa6, 0xa7]
const WHITE = [0xff, 0xff, 0xff]

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0 // filter: none
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/* --------------------------------------------------------------- 形状判定 */

function inRoundedRect(x, y, r) {
  const cx = Math.min(Math.max(x, r), 1 - r)
  const cy = Math.min(Math.max(y, r), 1 - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

function cross(ax, ay, bx, by, px, py) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax)
}

function inTriangle(px, py, a, b, c) {
  const d1 = cross(a[0], a[1], b[0], b[1], px, py)
  const d2 = cross(b[0], b[1], c[0], c[1], px, py)
  const d3 = cross(c[0], c[1], a[0], a[1], px, py)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

// 归一化坐标下：箭头尖 + 两侧翅膀 + 中间竖杆
const APEX = [0.5, 0.2]
const WING_L = [0.26, 0.46]
const WING_R = [0.74, 0.46]
const STEM = { x0: 0.43, x1: 0.57, y0: 0.4, y1: 0.78 }

function colorAt(x, y) {
  if (!inRoundedRect(x, y, 0.22)) return null
  if (inTriangle(x, y, APEX, WING_L, WING_R)) return WHITE
  if (x >= STEM.x0 && x <= STEM.x1 && y >= STEM.y0 && y <= STEM.y1) return WHITE
  return BRAND
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const step = 1 / (size * SS)
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const x = (px * SS + sx + 0.5) * step
          const y = (py * SS + sy + 0.5) * step
          const color = colorAt(x, y)
          if (!color) continue
          r += color[0]
          g += color[1]
          b += color[2]
          a += 255
        }
      }
      const samples = SS * SS
      const i = (py * size + px) * 4
      if (a > 0) {
        const covered = a / 255
        rgba[i] = Math.round(r / covered)
        rgba[i + 1] = Math.round(g / covered)
        rgba[i + 2] = Math.round(b / covered)
        rgba[i + 3] = Math.round(a / samples)
      }
    }
  }
  return encodePng(size, size, rgba)
}

mkdirSync(OUT_DIR, { recursive: true })
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`)
  writeFileSync(file, render(size))
  console.log('wrote ' + file)
}
