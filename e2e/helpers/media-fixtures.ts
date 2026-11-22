import crypto from 'node:crypto';
import zlib from 'node:zlib';

export function sha256Hex(bytes: Uint8Array | Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * Generates a genuine valid 4x4 RGBA PNG image with optional extra tEXt payload
 * to achieve deterministic unique hashes and target file sizes while remaining
 * 100% decodable by Chromium <img> elements.
 */
export function makeValidPng(seed = 1, extraBytes = 0): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(4, 0); // width
  ihdr.writeUInt32BE(4, 4); // height
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 4 rows of (1 filter byte + 4 * 4 RGBA bytes)
  const rawPixels = Buffer.alloc(4 * (1 + 16));
  for (let y = 0; y < 4; y++) {
    const rowOff = y * 17;
    rawPixels[rowOff] = 0;
    for (let x = 0; x < 4; x++) {
      const px = rowOff + 1 + x * 4;
      rawPixels[px] = (seed * 37 + x * 40) & 0xff;
      rawPixels[px + 1] = (seed * 73 + y * 50) & 0xff;
      rawPixels[px + 2] = (seed * 19 + x * 20 + y * 20) & 0xff;
      rawPixels[px + 3] = 255;
    }
  }
  const idat = zlib.deflateSync(rawPixels);
  const textPayload = Buffer.from(`Comment\0smb-e2e-seed-${seed}-${'X'.repeat(Math.max(0, extraBytes))}`, 'utf8');

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('tEXt', textPayload),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0))
  ]);
}

/**
 * Generates a genuine valid minimal baseline JPEG with an embedded APP1 EXIF segment
 * containing Camera Make/Model/DateTimeOriginal and deterministic seed comment.
 */
export function makeValidJpegWithExif(seed = 1, cameraMake = 'KhoAnhTestCam'): Buffer {
  // Minimal 1x1 baseline JPEG bytes (SOI .. EOI)
  const base1x1Jpeg = Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
    'base64'
  );
  // Ensure clean SOI (FF D8) and EOI (FF D9)
  const soi = base1x1Jpeg.subarray(0, 2);
  const rest = base1x1Jpeg.subarray(2);

  // Build synthetic APP1 Exif segment: FF E1 + 2-byte length + "Exif\0\0" + TIFF header + Make string
  const exifBody = Buffer.concat([
    Buffer.from('Exif\0\0', 'ascii'),
    Buffer.from('II*\0\x08\0\0\0', 'binary'), // TIFF little-endian header
    Buffer.from(`Make:${cameraMake}|Model:VAULT-${seed}|DateTimeOriginal:2026:11:22 05:30:00\0`, 'utf8')
  ]);
  const app1Len = Buffer.alloc(2);
  app1Len.writeUInt16BE(exifBody.length + 2, 0);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1]), app1Len, exifBody]);

  // Also add a COM segment for unique seed hash
  const comData = Buffer.from(`smb-jpeg-seed-${seed}`, 'utf8');
  const comLen = Buffer.alloc(2);
  comLen.writeUInt16BE(comData.length + 2, 0);
  const com = Buffer.concat([Buffer.from([0xff, 0xfe]), comLen, comData]);

  // Note: base1x1Jpeg already has an APP0 at offset 2; inserting APP1 right after SOI is valid JPEG
  const out = Buffer.concat([soi, app1, com, rest]);
  // Guarantee EOI marker
  if (out[out.length - 2] !== 0xff || out[out.length - 1] !== 0xd9) {
    return Buffer.concat([out, Buffer.from([0xff, 0xd9])]);
  }
  return out;
}

/**
 * Generates a deterministic MP4-like container with valid ISO BMFF ftyp + moov + mdat boxes.
 */
export function makeValidMp4(seed = 1, extraBytes = 256): Buffer {
  const ftypPayload = Buffer.from('isom\x00\x00\x02\x00isomiso2mp41', 'ascii');
  const ftyp = Buffer.alloc(8 + ftypPayload.length);
  ftyp.writeUInt32BE(ftyp.length, 0);
  ftyp.write('ftyp', 4, 'ascii');
  ftypPayload.copy(ftyp, 8);

  const moovPayload = Buffer.from(`mvhd-e2e-${seed}`, 'utf8');
  const moov = Buffer.alloc(8 + moovPayload.length);
  moov.writeUInt32BE(moov.length, 0);
  moov.write('moov', 4, 'ascii');
  moovPayload.copy(moov, 8);

  const mdatBody = Buffer.alloc(Math.max(32, extraBytes), (seed * 29) & 0xff);
  Buffer.from(`smb-mp4-seed-${seed}`, 'utf8').copy(mdatBody, 0);
  const mdat = Buffer.alloc(8 + mdatBody.length);
  mdat.writeUInt32BE(mdat.length, 0);
  mdat.write('mdat', 4, 'ascii');
  mdatBody.copy(mdat, 8);

  return Buffer.concat([ftyp, moov, mdat]);
}

export function makeNonMediaFixture(kind: 'txt' | 'pdf' | 'exe' | 'empty'): {
  filename: string;
  mimeType: string;
  bytes: Buffer;
} {
  if (kind === 'txt') {
    return {
      filename: 'notes.txt',
      mimeType: 'text/plain',
      bytes: Buffer.from('Not an image or video file', 'utf8')
    };
  }
  if (kind === 'pdf') {
    return {
      filename: 'document.pdf',
      mimeType: 'application/pdf',
      bytes: Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n', 'utf8')
    };
  }
  if (kind === 'exe') {
    return {
      filename: 'installer.exe',
      mimeType: 'application/x-msdownload',
      bytes: Buffer.from('MZ\x90\x00\x03\x00\x00\x00', 'binary')
    };
  }
  return {
    filename: 'empty.jpg',
    mimeType: 'image/jpeg',
    bytes: Buffer.alloc(0)
  };
}
