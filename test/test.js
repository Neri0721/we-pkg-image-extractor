/**
 * Minimal, dependency-free tests for the extraction core.
 *   node test/test.js
 */
'use strict';

const assert = require('assert');
const WE = require('../app.js');

const enc = new TextEncoder();

/** Builds a synthetic PKGV package the same shape as the real ones. */
function buildPkg(entries) {
  const names = entries.map(e => enc.encode(e.name));
  const headerSize = 4 + 8 + 4 + entries.reduce((a, e, i) => a + 4 + names[i].length + 1 + 8, 0);
  const dataSize = entries.reduce((a, e) => a + e.data.length, 0);

  const out = new Uint8Array(headerSize + dataSize);
  const dv = new DataView(out.buffer);
  let p = 0;

  dv.setUint32(p, 8, true); p += 4;
  out.set(enc.encode('PKGV0024'), p); p += 8;
  dv.setUint32(p, entries.length, true); p += 4;

  let offset = 0;
  entries.forEach((e, i) => {
    const n = names[i].length + 1;
    dv.setUint32(p, n, true); p += 4;
    out.set(names[i], p); p += names[i].length;
    out[p++] = 0;
    dv.setUint32(p, offset, true); p += 4;
    dv.setUint32(p, e.data.length, true); p += 4;
    offset += e.data.length;
  });

  entries.forEach(e => { out.set(e.data, p); p += e.data.length; });
  return out;
}

// 1x1 transparent PNG
const PNG_1PX = new Uint8Array(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'));

// A JPEG is only scanned by marker structure here, so a minimal valid-looking
// stream (SOI + APP0 + EOI) is enough to exercise the walker.
const JPEG_STUB = new Uint8Array([
  0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
]);

// fake tex header bytes in front of the payloads, like a real TEXV/TEXB block
const TEX_HEAD = new Uint8Array(64).fill(0x00);
TEX_HEAD.set(enc.encode('TEXV0005'), 0);
TEX_HEAD.set(enc.encode('TEXI0001'), 9);
TEX_HEAD.set(enc.encode('TEXB0004'), 46);

function concat(...parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const texABytes = concat(TEX_HEAD, PNG_1PX, PNG_1PX);      // two mip levels
const texBBytes = concat(TEX_HEAD, JPEG_STUB);
const pkgBytes = buildPkg([
  { name: 'scene.json', data: enc.encode('{"version": 5}') },
  { name: 'materials/a.tex', data: texABytes },
  { name: 'materials/b.tex', data: texBBytes },
]);

// --- pkg parsing -----------------------------------------------------------
const pkg = WE.parsePkg(pkgBytes);
assert.strictEqual(pkg.magic, 'PKGV0024');
assert.strictEqual(pkg.version, '0024');
assert.deepStrictEqual(pkg.entries.map(e => e.name),
  ['scene.json', 'materials/a.tex', 'materials/b.tex']);
assert.strictEqual(WE.entrySlice(pkg, pkg.entries[0])[0], 0x7B); // '{'
assert.strictEqual(pkg.entries[1].size, texABytes.length);

// --- error handling --------------------------------------------------------
assert.throws(() => WE.parsePkg(new Uint8Array(4)), /文件太小/);
assert.throws(() => WE.parsePkg(enc.encode('not a package at all')), /文件太小|文件头异常|PKGV/);
assert.throws(() => WE.parsePkg(enc.encode('PKGV0001')), /文件太小|文件头异常|PKGV/);

// --- image scanning --------------------------------------------------------
const texA = WE.entrySlice(pkg, pkg.entries[1]);
const aImgs = WE.findImages(texA, 0, texA.length);
assert.strictEqual(aImgs.length, 2, 'two PNG mips expected');
assert.strictEqual(aImgs[0].type, 'png');
assert.deepStrictEqual(Array.from(texA.slice(aImgs[0].start, aImgs[0].start + 8)),
  [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
assert.deepStrictEqual(
  Array.from(texA.slice(aImgs[0].start, aImgs[0].end)),
  Array.from(PNG_1PX), 'extracted PNG must match the payload byte for byte');

const texB = WE.entrySlice(pkg, pkg.entries[2]);
const bImgs = WE.findImages(texB, 0, texB.length);
assert.strictEqual(bImgs.length, 1, 'one JPEG expected');
assert.strictEqual(bImgs[0].type, 'jpg');
assert.deepStrictEqual(Array.from(texB.slice(bImgs[0].start, bImgs[0].end)), Array.from(JPEG_STUB));

// scanning the scene.json entry must not invent images
const json = WE.entrySlice(pkg, pkg.entries[0]);
assert.strictEqual(WE.findImages(json, 0, json.length).length, 0);

// --- CRC / zip -------------------------------------------------------------
assert.strictEqual(WE.crc32(enc.encode('123456789')), 0xCBF43926);

const zip = WE.makeZip([
  { name: 'materials/a_mip0.png', data: PNG_1PX },
  { name: 'materials/b.jpg', data: JPEG_STUB },
]);
const zdv = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
assert.strictEqual(zdv.getUint32(0, true), 0x04034B50, 'local file header signature');
const eocd = zip.length - 22;
assert.strictEqual(zdv.getUint32(eocd, true), 0x06054B50, 'end of central directory');
assert.strictEqual(zdv.getUint16(eocd + 10, true), 2, 'two entries');
assert.strictEqual(zdv.getUint16(6, true), 0x0800, 'UTF-8 filename flag');
assert.strictEqual(zdv.getUint16(8, true), 0, 'stored (no compression)');
const cdOffset = zdv.getUint32(eocd + 16, true);
assert.strictEqual(zdv.getUint32(cdOffset, true), 0x02014B50, 'central directory');

console.log('ok - all assertions passed');
