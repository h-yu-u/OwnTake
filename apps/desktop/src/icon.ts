import { deflateSync, crc32 } from 'node:zlib';

// The existing play-frame brand mark drawn as pixels at native resolution.
// Generating the PNG avoids a platform image dependency or runtime download.
export function iconPng(size = 32): Buffer {
  if (!Number.isInteger(size) || size < 16 || size > 1024) throw new Error('Invalid icon size');
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = (x + .5) / size, v = (y + .5) / size;
    const edge = u > .09 && u < .91 && v > .09 && v < .91 && (u < .16 || u > .84 || v < .16 || v > .84);
    const play = u >= .37 && u <= .71 && Math.abs(v - .5) <= (.71 - u) * .67;
    if (edge || play) {
      const at = y * (size * 4 + 1) + 1 + x * 4;
      raw.set([232, 189, 112, 255], at);
    }
  }
  function chunk(type: string, data: Buffer) {
    const label = Buffer.from(type), length = Buffer.alloc(4), crc = Buffer.alloc(4);
    length.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(Buffer.concat([label, data])));
    return Buffer.concat([length, label, data, crc]);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
