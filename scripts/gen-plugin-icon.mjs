#!/usr/bin/env node
// 生成插件图标 icons/icon128.png(品牌紫底 + 白色放大镜,纯 node+zlib 无第三方依赖)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const W = 128, H = 128;
const px = (x, y, [r, g, b, a]) => { const i = (y * W + x) * 4; d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = a; };
const d = new Uint8Array(W * H * 4);
const BG = [79, 99, 233, 255]; // #4f63e9
const FG = [255, 255, 255, 255];
for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) px(x, y, BG);
// 放大镜:圆环(圆心 54,54 半径 26 线宽 ~9) + 右下手柄(线宽 ~11,长 30)
for (let y = 0; y < H; y += 1) for (let x = 0; x < W; x += 1) {
  const dist = Math.hypot(x - 54, y - 54);
  if (Math.abs(dist - 26) <= 4.5) px(x, y, FG);
}
for (let t = 0; t <= 30; t += 0.25) {
  const cx = 54 + Math.SQRT1_2 * t, cy = 54 + Math.SQRT1_2 * t;
  for (let dy = -5.5; dy <= 5.5; dy += 0.5) for (let dx = -5.5; dx <= 5.5; dx += 0.5) {
    if (dx * dx + dy * dy <= 5.5 * 5.5) px(Math.round(cx + dx), Math.round(cy + dy), FG);
  }
}
// PNG 封装:signature + IHDR + IDAT(每行前置过滤字节 0) + IEND
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(body) >>> 0);
  return Buffer.concat([len, body, crc]);
};
const raw = Buffer.alloc(H * (1 + W * 4));
for (let y = 0; y < H; y += 1) {
  raw[y * (1 + W * 4)] = 0;
  Buffer.from(d.buffer, y * W * 4, W * 4).copy(raw, y * (1 + W * 4) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6;
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw)),
  chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'plugin', 'icons', 'icon128.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`✓ ${out} (${png.length} bytes)`);
