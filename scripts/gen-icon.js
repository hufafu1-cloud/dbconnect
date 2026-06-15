// 生成应用图标 assets/icon.png + assets/icon.ico（256x256，蓝底白色数据库圆柱）
// 仅使用 Node 内置模块，无需任何依赖。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 256, H = 256;
const rgba = Buffer.alloc(W * H * 4); // 默认全透明

// ---------- 配色与几何（Datavia：靛蓝底 + 白色「数据之道」节点路径） ----------
const TOP = [112, 126, 248];   // 顶部靛蓝
const BOT = [60, 50, 182];     // 底部深靛
const RECT = { x0: 8, y0: 8, x1: 247, y1: 247, r: 54 }; // 圆角矩形
const NODES = [                // 自左下向右上的三个节点（上行=向前/成长）
  { x: 72, y: 186, r: 21 },
  { x: 128, y: 122, r: 25 },
  { x: 186, y: 74, r: 19 },
];
const PATH_HW = 12;            // 连接路径半宽
const DOT = [60, 50, 182, 255]; // 节点内的靛蓝小圆点（端口感）

function inRoundRect(x, y) {
  const { x0, y0, x1, y1, r } = RECT;
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  if (x >= x0 + r && x <= x1 - r) return true;
  if (y >= y0 + r && y <= y1 - r) return true;
  const cx = x < x0 + r ? x0 + r : x1 - r;
  const cy = y < y0 + r ? y0 + r : y1 - r;
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
function distSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
function onPath(x, y) {
  for (let i = 0; i < NODES.length - 1; i++) {
    if (distSeg(x, y, NODES[i].x, NODES[i].y, NODES[i + 1].x, NODES[i + 1].y) <= PATH_HW) return true;
  }
  return false;
}
function nodeHit(x, y) {
  for (const n of NODES) {
    const d2 = (x - n.x) ** 2 + (y - n.y) ** 2;
    if (d2 <= (n.r * 0.42) ** 2) return 'dot';   // 内部靛蓝小圆点
    if (d2 <= n.r * n.r) return 'ring';          // 白色节点
  }
  return null;
}
// 取某采样点颜色（含 alpha），painter 顺序：节点点 > 节点白 > 路径白 > 渐变底 > 透明
function sample(x, y) {
  if (!inRoundRect(x, y)) return [0, 0, 0, 0];
  const nh = nodeHit(x, y);
  if (nh === 'dot') return DOT;
  if (nh === 'ring') return [255, 255, 255, 255];
  if (onPath(x, y)) return [255, 255, 255, 255];
  const t = (y - RECT.y0) / (RECT.y1 - RECT.y0);
  return [
    Math.round(TOP[0] + (BOT[0] - TOP[0]) * t),
    Math.round(TOP[1] + (BOT[1] - TOP[1]) * t),
    Math.round(TOP[2] + (BOT[2] - TOP[2]) * t),
    255,
  ];
}
// 3x3 超采样抗锯齿（预乘 alpha，边缘平滑）
for (let py = 0; py < H; py++) {
  for (let px = 0; px < W; px++) {
    let pr = 0, pg = 0, pb = 0, pa = 0;
    for (let sy = 0; sy < 3; sy++) {
      for (let sx = 0; sx < 3; sx++) {
        const c = sample(px + (sx + 0.5) / 3, py + (sy + 0.5) / 3);
        pr += c[0] * c[3]; pg += c[1] * c[3]; pb += c[2] * c[3]; pa += c[3];
      }
    }
    const i = (py * W + px) * 4;
    rgba[i] = pa ? Math.round(pr / pa) : 0;
    rgba[i + 1] = pa ? Math.round(pg / pa) : 0;
    rgba[i + 2] = pa ? Math.round(pb / pa) : 0;
    rgba[i + 3] = Math.round(pa / 9);
  }
}

// ---------- PNG 编码 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crc]);
}
function encodePNG(w, h, pixels) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = w * 4;
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

const png = encodePNG(W, H, rgba);

// ---------- ICO 封装（单个 256px PNG 条目） ----------
const header = Buffer.from([0, 0, 1, 0, 1, 0]);
const entry = Buffer.alloc(16);
entry[0] = 0; // 256 宽
entry[1] = 0; // 256 高
entry[4] = 1; // planes
entry[6] = 32; // bpp
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12);
const ico = Buffer.concat([header, entry, png]);

const dir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'icon.png'), png);
fs.writeFileSync(path.join(dir, 'icon.ico'), ico);
console.log('icon.png', png.length, 'bytes; icon.ico', ico.length, 'bytes');
