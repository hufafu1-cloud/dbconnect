// 生成应用图标 assets/icon.png + assets/icon.ico（256x256，蓝底白色数据库圆柱）
// 仅使用 Node 内置模块，无需任何依赖。
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 256, H = 256;
const rgba = Buffer.alloc(W * H * 4); // 默认全透明

// ---------- 像素工具 ----------
function setPx(x, y, r, g, b, a) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = a;
}
function lerp(a, b, t) { return Math.round(a + (b - a) * t); }

// 圆角矩形判定
function inRoundRect(x, y, x0, y0, x1, y1, rad) {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const cx = x < x0 + rad ? x0 + rad : (x > x1 - rad ? x1 - rad : x);
  const cy = y < y0 + rad ? y0 + rad : (y > y1 - rad ? y1 - rad : y);
  const dx = x - cx, dy = y - cy;
  return dx * dx + dy * dy <= rad * rad || (x >= x0 + rad && x <= x1 - rad) || (y >= y0 + rad && y <= y1 - rad);
}
function inEllipse(x, y, cx, cy, rx, ry) {
  const dx = (x - cx) / rx, dy = (y - cy) / ry;
  return dx * dx + dy * dy <= 1;
}
// 一节圆柱（上椭圆 + 矩形 + 下椭圆）
function inDisk(x, y, cx, topY, botY, rx, ry) {
  if (inEllipse(x, y, cx, topY, rx, ry)) return true;
  if (inEllipse(x, y, cx, botY, rx, ry)) return true;
  return Math.abs(x - cx) <= rx && y >= topY && y <= botY;
}

// ---------- 绘制 ----------
const top = [47, 129, 247], bottom = [21, 81, 196]; // 渐变蓝
for (let y = 0; y < H; y++) {
  const t = y / (H - 1);
  const r = lerp(top[0], bottom[0], t), g = lerp(top[1], bottom[1], t), b = lerp(top[2], bottom[2], t);
  for (let x = 0; x < W; x++) {
    if (inRoundRect(x, y, 8, 8, 247, 247, 52)) setPx(x, y, r, g, b, 255);
  }
}
// 三节白色圆柱
const disks = [[76, 102], [118, 144], [160, 186]];
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    for (const [t0, b0] of disks) {
      if (inDisk(x, y, 128, t0, b0, 66, 20)) {
        setPx(x, y, 255, 255, 255, 255);
        break;
      }
    }
  }
}
// 每节顶部画浅蓝椭圆高光，营造立体感
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    for (const [t0] of disks) {
      if (inEllipse(x, y, 128, t0, 58, 14)) { setPx(x, y, 199, 221, 252, 255); break; }
    }
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
