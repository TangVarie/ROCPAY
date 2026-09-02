// ============================================================
//  生成企微群发「小程序卡片」封面图（纯 Node，无外部图像库）
//  BYWOOD v5.1：深青底（brand.primary）+ 赭石礼盒（brand.accent，价值/礼物）+ 白丝带十字。
//  赭石是这张卡唯一的视觉重心（DESIGN.md §5·5）。卡片标题文字由企微单独显示，
//  封面无需渲染文字。输出 assets/reward-cover.png（企微封面推荐 ~5:4）。
//  运行：node scripts/make-cover.mjs
// ============================================================
import zlib from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, '../assets/reward-cover.png');

const W = 1080;
const H = 864;
const PRIMARY = [0x1e, 0x57, 0x54]; // #1E5754 深青（palette.json brand.primary）
const ACCENT = [0xb8, 0x50, 0x2f];  // #B8502F 赭石（brand.accent）
const WHITE = [0xff, 0xff, 0xff];

// 礼盒：居中正方 + 白丝带十字 + 顶部盒盖
const BX0 = 360, BX1 = 720, BY0 = 288, BY1 = 648; // 盒体 360×360
const LID0 = 264, LID1 = 336; // 盒盖 y 区间（略宽出盒体）
const LIDX0 = 336, LIDX1 = 744;
const RBV0 = 522, RBV1 = 558; // 竖丝带
const RBH0 = 450, RBH1 = 486; // 横丝带（略偏下，配合盒盖）

function colorAt(x, y) {
  // 盒盖
  if (y >= LID0 && y < LID1 && x >= LIDX0 && x < LIDX1) {
    if (x >= RBV0 && x < RBV1) return WHITE;
    return ACCENT;
  }
  // 盒体
  if (x >= BX0 && x < BX1 && y >= BY0 && y < BY1) {
    if ((x >= RBV0 && x < RBV1) || (y >= RBH0 && y < RBH1)) return WHITE;
    return ACCENT;
  }
  return PRIMARY;
}

// 原始扫描线：每行前置 filter 字节 0，再 W×RGB
const raw = Buffer.alloc(H * (1 + W * 3));
let p = 0;
for (let y = 0; y < H; y++) {
  raw[p++] = 0;
  for (let x = 0; x < W; x++) {
    const c = colorAt(x, y);
    raw[p++] = c[0];
    raw[p++] = c[1];
    raw[p++] = c[2];
  }
}

// ---- CRC32 ----
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 2; // color type RGB
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  sig,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, png);
console.log(`封面已生成：${OUT}  (${W}×${H}, ${png.length} 字节)`);
