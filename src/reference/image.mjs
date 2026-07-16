import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { ReferenceSystemError } from './errors.mjs';
import { REFERENCE_LIMITS } from './constants.mjs';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
const MAX_PNG_COMPARE_PIXELS = 10_000_000;

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

export function inspectImage(bytes, declaredExtension = null) {
  if (bytes instanceof Uint8Array && !Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    throw new ReferenceSystemError('DK_REFERENCE_IMAGE', 'reference image must contain bytes');
  }
  let metadata;
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(PNG_SIGNATURE)) metadata = inspectPng(bytes);
  else if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) metadata = inspectJpeg(bytes);
  else if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') metadata = inspectWebp(bytes);
  else throw new ReferenceSystemError('DK_REFERENCE_FORMAT', 'only valid PNG, JPEG, and WebP images are accepted');

  if (declaredExtension) {
    const ext = declaredExtension.toLowerCase().replace(/^\./, '');
    const expected = ext === 'jpg' ? 'jpeg' : ext;
    if (!REFERENCE_LIMITS.allowedFormats.includes(expected)) {
      throw new ReferenceSystemError('DK_REFERENCE_FORMAT', `unsupported image extension: .${ext}`);
    }
    if (metadata.format !== expected) {
      throw new ReferenceSystemError(
        'DK_REFERENCE_FORMAT',
        `image bytes are ${metadata.format}, but the filename declares .${ext}`,
      );
    }
  }
  if (metadata.width > REFERENCE_LIMITS.maxImageDimension || metadata.height > REFERENCE_LIMITS.maxImageDimension) {
    throw new ReferenceSystemError('DK_REFERENCE_DIMENSIONS', `image dimensions exceed ${REFERENCE_LIMITS.maxImageDimension}px`);
  }
  if (metadata.width * metadata.height > REFERENCE_LIMITS.maxImagePixels) {
    throw new ReferenceSystemError('DK_REFERENCE_DIMENSIONS', `image exceeds ${REFERENCE_LIMITS.maxImagePixels} pixels`);
  }
  return { ...metadata, bytes: bytes.length, sha256: sha256(bytes) };
}

function inspectPng(bytes) {
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') throw new ReferenceSystemError('DK_REFERENCE_FORMAT', 'PNG is missing IHDR');
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  if (!width || !height) throw new ReferenceSystemError('DK_REFERENCE_DIMENSIONS', 'PNG dimensions must be positive');
  return {
    format: 'png', mediaType: 'image/png', extension: 'png', width, height,
    bitDepth: bytes[24], colorType: bytes[25], interlace: bytes[28],
  };
}

function inspectJpeg(bytes) {
  let offset = 2;
  while (offset + 3 < bytes.length) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker == null || marker === 0xd9 || marker === 0xda) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (JPEG_SOF.has(marker)) {
      if (length < 7) break;
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      if (!width || !height) break;
      return { format: 'jpeg', mediaType: 'image/jpeg', extension: 'jpg', width, height };
    }
    offset += length;
  }
  throw new ReferenceSystemError('DK_REFERENCE_FORMAT', 'JPEG dimensions could not be read');
}

function inspectWebp(bytes) {
  const chunk = bytes.toString('ascii', 12, 16);
  let width;
  let height;
  if (chunk === 'VP8X' && bytes.length >= 30) {
    width = 1 + bytes.readUIntLE(24, 3);
    height = 1 + bytes.readUIntLE(27, 3);
  } else if (chunk === 'VP8L' && bytes.length >= 25 && bytes[20] === 0x2f) {
    const bits = bytes.readUInt32LE(21);
    width = 1 + (bits & 0x3fff);
    height = 1 + ((bits >>> 14) & 0x3fff);
  } else if (chunk === 'VP8 ' && bytes.length >= 30 && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) {
    width = bytes.readUInt16LE(26) & 0x3fff;
    height = bytes.readUInt16LE(28) & 0x3fff;
  }
  if (!width || !height) throw new ReferenceSystemError('DK_REFERENCE_FORMAT', 'WebP dimensions could not be read');
  return { format: 'webp', mediaType: 'image/webp', extension: 'webp', width, height };
}

export function decodePngRgba(bytes) {
  if (bytes instanceof Uint8Array && !Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  const meta = inspectPng(bytes);
  if (meta.bitDepth !== 8 || meta.interlace !== 0 || ![0, 2, 4, 6].includes(meta.colorType)) return null;
  const pixels = meta.width * meta.height;
  if (pixels > MAX_PNG_COMPARE_PIXELS) return null;
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[meta.colorType];
  const stride = meta.width * channels;
  const idat = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const end = offset + 12 + length;
    if (end > bytes.length) return null;
    if (type === 'IDAT') idat.push(bytes.subarray(offset + 8, offset + 8 + length));
    if (type === 'IEND') break;
    offset = end;
  }
  if (!idat.length) return null;
  const expected = (stride + 1) * meta.height;
  let raw;
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected }); }
  catch { return null; }
  if (raw.length !== expected) return null;
  const previous = Buffer.alloc(stride);
  const current = Buffer.alloc(stride);
  const rgbaBytes = Buffer.alloc(pixels * 4);
  const sums = [0, 0, 0, 0];
  const sumSquares = [0, 0, 0, 0];
  let source = 0;
  let target = 0;
  for (let y = 0; y < meta.height; y++) {
    const filter = raw[source++];
    for (let x = 0; x < stride; x++) {
      const value = raw[source++];
      const left = x >= channels ? current[x - channels] : 0;
      const up = previous[x];
      const upLeft = x >= channels ? previous[x - channels] : 0;
      let decoded;
      if (filter === 0) decoded = value;
      else if (filter === 1) decoded = value + left;
      else if (filter === 2) decoded = value + up;
      else if (filter === 3) decoded = value + Math.floor((left + up) / 2);
      else if (filter === 4) decoded = value + paeth(left, up, upLeft);
      else return null;
      current[x] = decoded & 0xff;
    }
    for (let x = 0; x < meta.width; x++) {
      const offset = x * channels;
      let red;
      let green;
      let blue;
      let alpha;
      if (meta.colorType === 0) {
        red = current[offset]; green = red; blue = red; alpha = 255;
      } else if (meta.colorType === 2) {
        red = current[offset]; green = current[offset + 1]; blue = current[offset + 2]; alpha = 255;
      } else if (meta.colorType === 4) {
        red = current[offset]; green = red; blue = red; alpha = current[offset + 1];
      } else {
        red = current[offset]; green = current[offset + 1]; blue = current[offset + 2]; alpha = current[offset + 3];
      }
      const rgba = [red, green, blue, alpha];
      for (let channel = 0; channel < 4; channel++) {
        rgbaBytes[target++] = rgba[channel];
        sums[channel] += rgba[channel];
        sumSquares[channel] += rgba[channel] * rgba[channel];
      }
    }
    current.copy(previous);
  }
  const mean = sums.map((value) => round6(value / pixels));
  const standardDeviation = sumSquares.map((value, index) => round6(Math.sqrt(Math.max(0, value / pixels - mean[index] ** 2))));
  return {
    width: meta.width,
    height: meta.height,
    rgba: rgbaBytes,
    stats: { pixels, meanRgba: mean, standardDeviationRgba: standardDeviation },
  };
}

export function pngPixelStats(bytes) {
  return decodePngRgba(bytes)?.stats ?? null;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function round6(value) {
  return Math.round(value * 1_000_000) / 1_000_000;
}
