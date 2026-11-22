import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { classifyMediaFormat } from '@smb/shared';
import { sha256Bytes } from '../../apps/web/src/utils/sha256.js';

describe('Media Format Classifier (PRD 2.3 & 2.4) & Pure-TS SHA-256 Parity', () => {
  it('accepts common, Apple, RAW/ProRAW, DNG, TIFF, and ProRes photo/video formats', () => {
    expect(classifyMediaFormat('IMG_0001.HEIC', 'application/octet-stream')).toBe('image');
    expect(classifyMediaFormat('IMG_ProRAW.DNG', '')).toBe('image');
    expect(classifyMediaFormat('DSC01234.ARW', 'application/octet-stream')).toBe('image');
    expect(classifyMediaFormat('photo.cr3')).toBe('image');
    expect(classifyMediaFormat('scan.tiff')).toBe('image');
    expect(classifyMediaFormat('clip.MOV', 'video/quicktime')).toBe('video');
    expect(classifyMediaFormat('master.prores', '')).toBe('video');
    expect(classifyMediaFormat('footage.mxf')).toBe('video');
  });

  it('rejects non-media documents, archives, and executables', () => {
    expect(classifyMediaFormat('PRD.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBeNull();
    expect(classifyMediaFormat('invoice.pdf', 'application/pdf')).toBeNull();
    expect(classifyMediaFormat('setup.exe')).toBeNull();
    expect(classifyMediaFormat('archive.zip')).toBeNull();
    expect(classifyMediaFormat('notes.txt', 'text/plain')).toBeNull();
  });

  it('matches Node OpenSSL SHA-256 bit-for-bit across boundary lengths', () => {
    const lengths = [0, 1, 55, 56, 57, 63, 64, 65, 128, 1024, 250_000];
    for (const len of lengths) {
      const buf = crypto.randomBytes(len);
      const expected = crypto.createHash('sha256').update(buf).digest('hex');
      const actual = sha256Bytes(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
      expect(actual).toBe(expected);
    }
  });
});
