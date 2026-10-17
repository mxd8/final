/**
 * PWA 图标生成器：零依赖，纯 Node（zlib）手写 PNG 编码器。
 *
 * 设计：暗色垂直渐变底（呼应 iOS 液态玻璃深色氛围）+ 金色渐变闪电（品牌 ⚡）。
 * 渲染在 2048 超采样画布上做区域平均缩放，边缘平滑。
 *
 * 产物（全部写入 public/）：
 *   icons/icon-192.png / icon-512.png        —— manifest purpose "any"（全出血底色）
 *   icons/maskable-192.png / maskable-512.png —— purpose "maskable"（闪电缩小到安全圈内）
 *   icons/mono-512.png                        —— purpose "monochrome"（纯黑闪电 + 透明底）
 *   icons/apple-touch-icon.png                —— iOS 主屏图标 180×180（不透明底）
 *   icons/favicon-32.png                      —— 浏览器标签 PNG 兜底（Safari 不认 SVG favicon）
 *   favicon.svg                               —— 矢量 favicon（Chrome / Firefox / Edge 用）
 *
 * 平时不需要重跑；改了设计或尺寸后 node scripts/make-icons.mjs 重新生成。
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PUBLIC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const ICONS_DIR = join(PUBLIC_DIR, 'icons');

/* ---------------------------------------------------------------- PNG 编码 */

const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length); // length(4) + type(4) + data + crc(4)
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** RGBA 像素缓冲（Float32，0..255）→ PNG（color type 6，filter 0，直通 alpha） */
function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    raw[row] = 0; // 每行行首的 filter 字节
    for (let x = 0; x < stride; x++) {
      const v = rgba[y * stride + x];
      raw[row + 1 + x] = v <= 0 ? 0 : v >= 255 ? 255 : Math.round(v);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // color type：RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* -------------------------------------------------------------------- 绘制 */

/** 闪电多边形（0..1 归一化坐标，宽 0.64 × 高 1.0） */
const BOLT = [[0.60, 0.00], [0.18, 0.55], [0.45, 0.55], [0.38, 1.00], [0.82, 0.42], [0.52, 0.42]];

const lerp = (a, b, t) => a + (b - a) * t;
const clamp01 = (t) => Math.min(1, Math.max(0, t));

function inPolygon(px, py, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 在 w×w 画布上渲染一帧。返回 Float32Array（RGBA，0..255）。
 * - mono：纯黑闪电 + 透明底（manifest monochrome 用）
 * - 否则：不透明渐变底 + 辉光 + 金色渐变闪电
 */
function render(w, { boltHeight, mono = false }) {
  const px = new Float32Array(w * w * 4);
  const cx = w / 2;
  const cy = w / 2 - w * 0.008; // 闪电视觉重心略上移
  const bh = boltHeight * w;
  const bw = 0.64 * bh;
  const bx = cx - bw / 2;
  const by = cy - bh / 2;
  const poly = BOLT.map(([nx, ny]) => [bx + nx * bw, by + ny * bh]);
  const x0 = Math.max(0, Math.floor(bx) - 2);
  const x1 = Math.min(w - 1, Math.ceil(bx + bw) + 2);
  const y0 = Math.max(0, Math.floor(by) - 2);
  const y1 = Math.min(w - 1, Math.ceil(by + bh) + 2);

  for (let y = 0; y < w; y++) {
    // 底色垂直渐变：#2E2E40 → #0D0D15
    const tBg = y / (w - 1);
    const bgR = lerp(0x2e, 0x0d, tBg);
    const bgG = lerp(0x2e, 0x0d, tBg);
    const bgB = lerp(0x40, 0x15, tBg);
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      if (mono) {
        px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 0;
      } else {
        // 闪电后方一圈暖色辉光，让玻璃底有一点「环境光」
        const dx = (x - cx) / (0.55 * w);
        const dy = (y - 0.45 * w) / (0.55 * w);
        const g = Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy));
        const glow = g * g * 0.16;
        px[i] = Math.min(255, bgR + 255 * glow);
        px[i + 1] = Math.min(255, bgG + 214 * glow);
        px[i + 2] = Math.min(255, bgB + 10 * glow);
        px[i + 3] = 255;
      }
      if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && inPolygon(x + 0.5, y + 0.5, poly)) {
        if (mono) {
          px[i] = 0; px[i + 1] = 0; px[i + 2] = 0; px[i + 3] = 255;
        } else {
          // 闪电本体：#FFE066 → #FF9F0A 垂直渐变
          const tB = clamp01((y + 0.5 - by) / bh);
          px[i] = lerp(255, 255, tB);
          px[i + 1] = lerp(0xe0, 0x9f, tB);
          px[i + 2] = lerp(0x66, 0x0a, tB);
        }
      }
    }
  }
  return px;
}

/** 通用区域平均缩放（支持非整数倍率，如 2048 → 192 / 180） */
function resize(src, sw, dw) {
  const dst = new Float32Array(dw * dw * 4);
  const ratio = sw / dw;
  for (let y = 0; y < dw; y++) {
    const fy0 = y * ratio;
    const fy1 = (y + 1) * ratio;
    for (let x = 0; x < dw; x++) {
      const fx0 = x * ratio;
      const fx1 = (x + 1) * ratio;
      let r = 0, g = 0, b = 0, a = 0, area = 0;
      for (let sy = Math.floor(fy0); sy < Math.ceil(fy1); sy++) {
        const wy = Math.min(fy1, sy + 1) - Math.max(fy0, sy);
        for (let sx = Math.floor(fx0); sx < Math.ceil(fx1); sx++) {
          const wx = Math.min(fx1, sx + 1) - Math.max(fx0, sx);
          const wgt = wx * wy;
          area += wgt;
          const i = (sy * sw + sx) * 4;
          // 预乘 alpha 累加，避免透明边缘出现黑边
          const pa = (src[i + 3] / 255) * wgt;
          r += src[i] * pa; g += src[i + 1] * pa; b += src[i + 2] * pa;
          a += (src[i + 3] / 255) * wgt;
        }
      }
      const o = (y * dw + x) * 4;
      if (a > 0) {
        // PNG 是直通 alpha：颜色除以累积 alpha 还原平均色，不预乘
        dst[o] = Math.round(r / a);
        dst[o + 1] = Math.round(g / a);
        dst[o + 2] = Math.round(b / a);
      }
      dst[o + 3] = Math.round((a / area) * 255);
    }
  }
  return dst;
}

function writeIcon(name, size, frame) {
  const png = encodePNG(size, size, frame);
  writeFileSync(join(ICONS_DIR, name), png);
  console.log(`  ${name.padEnd(22)} ${size}×${size}  ${(png.length / 1024).toFixed(1)} KB`);
}

/* -------------------------------------------------------------------- 产物 */

mkdirSync(ICONS_DIR, { recursive: true });

const BASE = 2048;
const anyFrame = render(BASE, { boltHeight: 0.60 });
const maskableFrame = render(BASE, { boltHeight: 0.50 }); // maskable 安全圈：内容须落在中心 80% 直径内
const monoFrame = render(BASE, { boltHeight: 0.55, mono: true });

console.log('生成图标：');
for (const size of [512, 192]) writeIcon(`icon-${size}.png`, size, resize(anyFrame, BASE, size));
writeIcon('apple-touch-icon.png', 180, resize(anyFrame, BASE, 180));
writeIcon('favicon-32.png', 32, resize(anyFrame, BASE, 32));
for (const size of [512, 192]) writeIcon(`maskable-${size}.png`, size, resize(maskableFrame, BASE, size));
writeIcon('mono-512.png', 512, resize(monoFrame, BASE, 512));

/* favicon.svg：与 PNG 同一套闪电坐标（512 视图框，圆角矩形底） */
{
  const size = 512;
  const bh = 0.62 * size;
  const bw = 0.64 * bh;
  const bx = size / 2 - bw / 2;
  const by = size / 2 - size * 0.008 - bh / 2;
  const pts = BOLT.map(([nx, ny]) => `${(bx + nx * bw).toFixed(1)},${(by + ny * bh).toFixed(1)}`).join(' ');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2E2E40"/>
      <stop offset="1" stop-color="#0D0D15"/>
    </linearGradient>
    <linearGradient id="bolt" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#FFE066"/>
      <stop offset="1" stop-color="#FF9F0A"/>
    </linearGradient>
  </defs>
  <rect width="512" height="512" rx="116" fill="url(#bg)"/>
  <polygon points="${pts}" fill="url(#bolt)"/>
</svg>
`;
  writeFileSync(join(PUBLIC_DIR, 'favicon.svg'), svg);
  console.log('  favicon.svg             512 视图框（矢量）');
}
console.log('完成。');
