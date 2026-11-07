import { deflateSync } from "node:zlib";

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ (buf[i] as number)) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, "ascii");
  Buffer.from(data.buffer, data.byteOffset, data.length).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

/** A pixel buffer as the RFB client stores it: 4 bytes per pixel, in the order blue, green, red, unused. */
export interface Bgrx {
  width: number;
  height: number;
  data: Uint8Array;
}

/** Halves a picture in each direction by averaging 2x2 blocks. */
export function halve(img: Bgrx): Bgrx {
  const width = Math.max(1, img.width >> 1);
  const height = Math.max(1, img.height >> 1);
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        let sum = 0;
        for (let dy = 0; dy < 2; dy++) {
          for (let dx = 0; dx < 2; dx++) {
            const sx = Math.min(img.width - 1, x * 2 + dx);
            const sy = Math.min(img.height - 1, y * 2 + dy);
            sum += img.data[(sy * img.width + sx) * 4 + c] as number;
          }
        }
        out[(y * width + x) * 4 + c] = sum >> 2;
      }
    }
  }
  return { width, height, data: out };
}

/** An RGB, 8 bits per channel PNG of a BGRX picture. */
export function encodePng(img: Bgrx): Buffer {
  const { width, height, data } = img;
  const raw = Buffer.alloc(height * (1 + width * 3));
  let o = 0;
  for (let y = 0; y < height; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      raw[o++] = data[i + 2] as number;
      raw[o++] = data[i + 1] as number;
      raw[o++] = data[i] as number;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
