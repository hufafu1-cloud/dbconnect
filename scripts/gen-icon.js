// Generate DBPanda Windows assets from the exact user-approved panda artwork.
// The artwork itself is never redrawn: this script only crops, resizes,
// and packages it as PNG/ICO using Node built-ins.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const OUTPUT_PNG_SIZE = 1024;
const SOURCE_PATH = path.join(__dirname, '..', 'assets', 'dbpanda-logo.png');

// Square crop containing only the panda-plus-database emblem. The complete
// transparent wordmark remains available separately as assets/dbpanda-logo.png.
const BADGE = {
  cropX: 350,
  cropY: 150,
  cropSize: 550,
};

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(buffer) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (!signature.every((value, index) => buffer[index] === value)) throw new Error('Invalid PNG signature');
  let position = 8;
  let width;
  let height;
  let bitDepth;
  let colorType;
  let interlace;
  const idat = [];
  while (position < buffer.length) {
    const length = buffer.readUInt32BE(position);
    const type = buffer.toString('ascii', position + 4, position + 8);
    const data = buffer.subarray(position + 8, position + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    position += length + 12;
  }
  if (bitDepth !== 8 || ![2, 6].includes(colorType) || interlace !== 0) {
    throw new Error(`Unsupported source PNG format: depth=${bitDepth}, color=${colorType}, interlace=${interlace}`);
  }

  const channels = colorType === 2 ? 3 : 4;
  const stride = width * channels;
  const filtered = zlib.inflateSync(Buffer.concat(idat));
  const pixels = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = filtered[rowStart];
    for (let x = 0; x < stride; x++) {
      const raw = filtered[rowStart + 1 + x];
      const output = y * stride + x;
      const left = x >= channels ? pixels[output - channels] : 0;
      const up = y > 0 ? pixels[output - stride] : 0;
      const upLeft = y > 0 && x >= channels ? pixels[output - stride - channels] : 0;
      let value;
      if (filter === 0) value = raw;
      else if (filter === 1) value = raw + left;
      else if (filter === 2) value = raw + up;
      else if (filter === 3) value = raw + Math.floor((left + up) / 2);
      else if (filter === 4) value = raw + paeth(left, up, upLeft);
      else throw new Error(`Unsupported PNG filter: ${filter}`);
      pixels[output] = value & 0xff;
    }
  }

  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0, j = 0; i < pixels.length; i += channels, j += 4) {
    rgba[j] = pixels[i];
    rgba[j + 1] = pixels[i + 1];
    rgba[j + 2] = pixels[i + 2];
    rgba[j + 3] = channels === 4 ? pixels[i + 3] : 255;
  }
  return { width, height, rgba };
}

function sourcePixel(image, x, y) {
  const x0 = Math.max(0, Math.min(image.width - 1, Math.floor(x)));
  const y0 = Math.max(0, Math.min(image.height - 1, Math.floor(y)));
  const x1 = Math.min(image.width - 1, x0 + 1);
  const y1 = Math.min(image.height - 1, y0 + 1);
  const tx = clamp(x - x0);
  const ty = clamp(y - y0);
  const out = [0, 0, 0, 0];
  for (let c = 0; c < 4; c++) {
    const a = image.rgba[(y0 * image.width + x0) * 4 + c];
    const b = image.rgba[(y0 * image.width + x1) * 4 + c];
    const d = image.rgba[(y1 * image.width + x0) * 4 + c];
    const e = image.rgba[(y1 * image.width + x1) * 4 + c];
    out[c] = (a * (1 - tx) + b * tx) * (1 - ty) + (d * (1 - tx) + e * tx) * ty;
  }
  return out;
}

function approvedArtworkSample(image, u, v) {
  const x = BADGE.cropX + u * BADGE.cropSize;
  const y = BADGE.cropY + v * BADGE.cropSize;
  return sourcePixel(image, x, y);
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  const crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function encodePng(width, height, pixels) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    pixels.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function loadApprovedArtwork() {
  const image = decodePng(fs.readFileSync(SOURCE_PATH));
  if (image.width !== 1254 || image.height !== 1254) throw new Error('Approved DBPanda logo must remain 1254x1254');
  return image;
}

function renderPng(size, image = loadApprovedArtwork()) {
  const pixels = Buffer.alloc(size * size * 4);
  const supersampling = size <= 64 ? 4 : size <= 256 ? 2 : 1;
  const samples = supersampling * supersampling;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      for (let sy = 0; sy < supersampling; sy++) {
        for (let sx = 0; sx < supersampling; sx++) {
          const color = approvedArtworkSample(
            image,
            (px + (sx + 0.5) / supersampling) / size,
            (py + (sy + 0.5) / supersampling) / size,
          );
          pr += color[0] * color[3];
          pg += color[1] * color[3];
          pb += color[2] * color[3];
          pa += color[3];
        }
      }
      const offset = (py * size + px) * 4;
      pixels[offset] = pa ? Math.round(pr / pa) : 0;
      pixels[offset + 1] = pa ? Math.round(pg / pa) : 0;
      pixels[offset + 2] = pa ? Math.round(pb / pa) : 0;
      pixels[offset + 3] = Math.round(pa / samples);
    }
  }
  return encodePng(size, size, pixels);
}

function encodeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  const entries = Buffer.alloc(images.length * 16);
  let offset = 6 + entries.length;
  images.forEach(({ size, png }, index) => {
    const entry = index * 16;
    entries[entry] = size === 256 ? 0 : size;
    entries[entry + 1] = size === 256 ? 0 : size;
    entries[entry + 4] = 1;
    entries[entry + 6] = 32;
    entries.writeUInt32LE(png.length, entry + 8);
    entries.writeUInt32LE(offset, entry + 12);
    offset += png.length;
  });
  return Buffer.concat([header, entries, ...images.map(({ png }) => png)]);
}

function generate(outputDir = path.join(__dirname, '..', 'assets')) {
  fs.mkdirSync(outputDir, { recursive: true });
  const image = loadApprovedArtwork();
  const png = renderPng(OUTPUT_PNG_SIZE, image);
  const icoImages = ICO_SIZES.map((size) => ({ size, png: renderPng(size, image) }));
  fs.writeFileSync(path.join(outputDir, 'icon.png'), png);
  fs.writeFileSync(path.join(outputDir, 'icon.ico'), encodeIco(icoImages));
  console.log(`Generated exact approved DBPanda emblem: ${OUTPUT_PNG_SIZE}px PNG, ICO [${ICO_SIZES.join(', ')}]`);
}

if (require.main === module) generate();

module.exports = { BADGE, ICO_SIZES, OUTPUT_PNG_SIZE, SOURCE_PATH, decodePng, encodeIco, generate, renderPng };
