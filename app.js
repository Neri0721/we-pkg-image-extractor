/* Wallpaper Engine PKG image extractor.
 * Parses the PKGV container, finds PNG payloads inside TEXB textures and
 * exposes them for preview + download. Everything runs locally.
 */
const WE = (() => {
  'use strict';

  const PNG_SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const dec = new TextDecoder('utf-8');
  const enc = new TextEncoder();

  const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

  /* ------------------------------------------------------------------ pkg */

  function parsePkg(bytes) {
    if (bytes.length < 16) throw new Error('文件太小，不是有效的 pkg。');
    let pos = 0;
    const magicLen = u32le(bytes, pos); pos += 4;
    if (magicLen < 4 || magicLen > 64 || pos + magicLen > bytes.length) {
      throw new Error('不是 Wallpaper Engine 的 pkg（文件头异常）。');
    }
    const magic = dec.decode(bytes.subarray(pos, pos + magicLen)); pos += magicLen;
    if (!magic.startsWith('PKGV')) {
      throw new Error('不是 Wallpaper Engine 的 pkg（缺少 PKGV 标记）。');
    }

    const count = u32le(bytes, pos); pos += 4;
    if (count > 200000) throw new Error('条目数异常，文件可能损坏。');

    const entries = [];
    for (let i = 0; i < count; i++) {
      if (pos + 4 > bytes.length) throw new Error('条目表损坏。');
      const nameLen = u32le(bytes, pos); pos += 4;
      if (nameLen > 4096 || pos + nameLen > bytes.length) throw new Error('条目名损坏。');
      let end = pos + nameLen;
      let nameEnd = end;
      while (nameEnd > pos && bytes[nameEnd - 1] === 0) nameEnd--;
      const name = dec.decode(bytes.subarray(pos, nameEnd));
      pos = end;

      if (pos + 8 > bytes.length) throw new Error('条目表损坏。');
      const offset = u32le(bytes, pos);
      const size = u32le(bytes, pos + 4);
      pos += 8;
      entries.push({ name, offset, size });
    }

    const dataStart = pos;
    // Offsets are relative to the end of the entry table. Guard against
    // versions that store absolute offsets instead.
    for (const e of entries) {
      if (dataStart + e.offset + e.size > bytes.length && e.offset + e.size <= bytes.length) {
        e.absolute = true;
      }
    }
    const total = entries.reduce((a, e) => a + e.size, 0);
    return { magic, version: magic.slice(4), entries, dataStart, bytes, total };
  }

  function entrySlice(pkg, e) {
    const start = e.absolute ? e.offset : pkg.dataStart + e.offset;
    const end = Math.min(start + e.size, pkg.bytes.length);
    return pkg.bytes.subarray(start, end);
  }

  /* ------------------------------------------------------------------ png */

  function pngEnd(bytes, start, limit) {
    let p = start + 8;
    while (p + 8 <= limit) {
      const len = u32be(bytes, p);
      const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
      if (!/^[A-Za-z]{4}$/.test(type)) return -1;
      const next = p + 12 + len;
      if (next > limit) return -1;
      if (type === 'IEND') return next;
      p = next;
    }
    return -1;
  }

  function jpegEnd(bytes, start, limit) {
    let p = start + 2;
    while (p + 1 < limit) {
      if (bytes[p] !== 0xFF) { p++; continue; }
      let m = bytes[p + 1];
      while (m === 0xFF && p + 2 < limit) { p++; m = bytes[p + 1]; }
      if (m === 0xD9) return p + 2;
      if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) { p += 2; continue; }
      if (p + 4 > limit) return -1;
      const segLen = (bytes[p + 2] << 8) | bytes[p + 3];
      if (segLen < 2) return -1;
      if (m === 0xDA) {
        // inside entropy-coded data: FF 00 is stuffing, FF D9 ends the image
        let q = p + 2 + segLen;
        let closed = false;
        while (q + 1 < limit) {
          if (bytes[q] === 0xFF) {
            const nx = bytes[q + 1];
            if (nx === 0x00 || (nx >= 0xD0 && nx <= 0xD7)) { q += 2; continue; }
            if (nx === 0xD9) return q + 2;
            if (nx === 0xFF) { q++; continue; }
            p = q; closed = true; break;
          }
          q++;
        }
        if (!closed) return -1;
        continue;
      }
      p += 2 + segLen;
    }
    return -1;
  }

  /** Finds every PNG / JPEG image embedded in a byte range. */
  function findImages(bytes, start, end) {
    const out = [];
    let i = start;
    while (i < end - 2) {
      let stop = -1, type = null;
      if (bytes[i] === 0x89 && bytes[i + 1] === 0x50 && bytes[i + 2] === 0x4e && bytes[i + 3] === 0x47 &&
          bytes[i + 4] === 0x0d && bytes[i + 5] === 0x0a && bytes[i + 6] === 0x1a && bytes[i + 7] === 0x0a) {
        const s = pngEnd(bytes, i, end);
        if (s > i) { stop = s; type = 'png'; }
      } else if (bytes[i] === 0xFF && bytes[i + 1] === 0xD8 && bytes[i + 2] === 0xFF) {
        const s = jpegEnd(bytes, i, end);
        if (s > i) { stop = s; type = 'jpg'; }
      }
      if (stop > i) { out.push({ type, start: i, end: stop }); i = stop; }
      else i++;
    }
    return out;
  }

  function texFormat(bytes) {
    if (bytes.length < 16) return null;
    const m1 = String.fromCharCode.apply(null, bytes.subarray(0, 8));
    if (!m1.startsWith('TEXV')) return null;
    return m1.slice(0, 4) + ' ' + m1.slice(4);
  }

  /* ------------------------------------------------------------------ zip */
  // Minimal STORE-only zip writer, UTF-8 names.

  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(data) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function makeZip(files) {
    const now = new Date();
    const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const dosDate = ((Math.max(now.getFullYear(), 1980) - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();

    const prepared = files.map(f => {
      const nameBytes = enc.encode(f.name);
      return { name: nameBytes, data: f.data, crc: crc32(f.data) };
    });

    let size = 0;
    for (const f of prepared) size += 30 + f.name.length + f.data.length + 46 + f.name.length;
    size += 22;

    const out = new Uint8Array(size);
    const dv = new DataView(out.buffer);
    let p = 0;
    const central = [];

    for (const f of prepared) {
      central.push({ name: f.name, crc: f.crc, size: f.data.length, offset: p });
      dv.setUint32(p, 0x04034b50, true);
      dv.setUint16(p + 4, 20, true);
      dv.setUint16(p + 6, 0x0800, true); // UTF-8 flag
      dv.setUint16(p + 8, 0, true);     // store
      dv.setUint16(p + 10, dosTime, true);
      dv.setUint16(p + 12, dosDate, true);
      dv.setUint32(p + 14, f.crc, true);
      dv.setUint32(p + 18, f.data.length, true);
      dv.setUint32(p + 22, f.data.length, true);
      dv.setUint16(p + 26, f.name.length, true);
      dv.setUint16(p + 28, 0, true);
      p += 30;
      out.set(f.name, p); p += f.name.length;
      out.set(f.data, p); p += f.data.length;
    }

    const cdStart = p;
    for (const f of central) {
      dv.setUint32(p, 0x02014b50, true);
      dv.setUint16(p + 4, 20, true);
      dv.setUint16(p + 6, 20, true);
      dv.setUint16(p + 8, 0x0800, true);
      dv.setUint16(p + 10, 0, true);
      dv.setUint16(p + 12, dosTime, true);
      dv.setUint16(p + 14, dosDate, true);
      dv.setUint32(p + 16, f.crc, true);
      dv.setUint32(p + 20, f.size, true);
      dv.setUint32(p + 24, f.size, true);
      dv.setUint16(p + 28, f.name.length, true);
      dv.setUint16(p + 30, 0, true);
      dv.setUint16(p + 32, 0, true);
      dv.setUint16(p + 34, 0, true);
      dv.setUint16(p + 36, 0, true);
      dv.setUint32(p + 38, 0, true);
      dv.setUint32(p + 42, f.offset, true);
      p += 46;
      out.set(f.name, p); p += f.name.length;
    }
    const cdSize = p - cdStart;

    dv.setUint32(p, 0x06054b50, true);
    dv.setUint16(p + 4, 0, true);
    dv.setUint16(p + 6, 0, true);
    dv.setUint16(p + 8, central.length, true);
    dv.setUint16(p + 10, central.length, true);
    dv.setUint32(p + 12, cdSize, true);
    dv.setUint32(p + 16, cdStart, true);
    dv.setUint16(p + 20, 0, true);
    return out;
  }

  return { parsePkg, entrySlice, findImages, texFormat, makeZip, crc32 };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = WE;

/* ====================================================================== UI */
if (typeof document !== 'undefined') (function init() {
  'use strict';

  const $ = s => document.querySelector(s);
  const drop = $('#drop');
  const fileInput = $('#file');
  const result = $('#result');
  const gallery = $('#gallery');
  const stat = $('#stat');
  const entryList = $('#entryList');
  const entryCount = $('#entryCount');
  const noimg = $('#noimg');
  const zipBtn = $('#zip');
  const resetBtn = $('#reset');
  const toastEl = $('#toast');

  const state = { items: [], pkgs: [], names: new Set() };

  const kb = n => n < 1024 ? n + ' B' : n < 1048576 ? (n / 1024).toFixed(1) + ' KB' : (n / 1048576).toFixed(2) + ' MB';

  let toastTimer = 0;
  function toast(msg, isErr) {
    toastEl.textContent = msg;
    toastEl.className = 'toast show' + (isErr ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.className = 'toast'; }, 3600);
  }

  function saveBlob(blob, filename) {
    const a = document.createElement('a');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }

  function uniqueName(name) {
    let candidate = name, i = 2;
    while (state.names.has(candidate)) {
      const dot = name.lastIndexOf('.');
      candidate = dot > 0 ? `${name.slice(0, dot)} (${i})${name.slice(dot)}` : `${name} (${i})`;
      i++;
    }
    state.names.add(candidate);
    return candidate;
  }

  function dims(blob) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => { resolve({ w: img.naturalWidth, h: img.naturalHeight, url }); };
      img.onerror = () => { URL.revokeObjectURL(url); resolve({ w: 0, h: 0, url: '' }); };
      img.src = url;
    });
  }

  function card(item) {
    const fig = document.createElement('figure');
    fig.className = 'card';

    const thumb = document.createElement('a');
    thumb.className = 'thumb';
    thumb.href = '#';
    thumb.setAttribute('aria-label', '查看大图');
    if (item.w && item.h) thumb.style.aspectRatio = `${item.w} / ${item.h}`;
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.alt = item.name;
    img.src = item.url;
    thumb.appendChild(img);
    thumb.addEventListener('click', ev => {
      ev.preventDefault();
      $('#lbImg').src = item.url;
      $('#lightbox').classList.add('open');
    });

    const body = document.createElement('div');
    body.className = 'body';

    const nameEl = document.createElement('div');
    nameEl.className = 'name';
    nameEl.textContent = item.name;
    nameEl.title = item.path;

    const meta = document.createElement('div');
    meta.className = 'meta';
    const sizePill = document.createElement('span');
    sizePill.className = 'pill';
    sizePill.textContent = item.w && item.h ? `${item.w}×${item.h}` : '尺寸未知';
    const bytesPill = document.createElement('span');
    bytesPill.className = 'pill';
    bytesPill.textContent = kb(item.blob.size);
    const typePill = document.createElement('span');
    typePill.className = 'pill';
    typePill.textContent = item.type === 'jpg' ? 'JPG' : 'PNG';
    meta.append(sizePill, bytesPill, typePill);
    if (item.mip === 0) {
      const hot = document.createElement('span');
      hot.className = 'pill hot';
      hot.textContent = '原图';
      meta.appendChild(hot);
    }

    const dl = document.createElement('button');
    dl.className = 'btn';
    dl.textContent = item.type === 'jpg' ? '下载 JPG' : '下载 PNG';
    dl.addEventListener('click', () => saveBlob(item.blob, item.filename));

    body.append(nameEl, meta, dl);
    fig.append(thumb, body);
    return fig;
  }

  function renderMeta() {
    const pkgs = state.pkgs;
    const bytes = pkgs.reduce((a, p) => a + p.bytes.length, 0);
    const parts = [`<b>${pkgs.length}</b> 个 pkg`, `<b>${state.pkgs.reduce((a, p) => a + p.entries.length, 0)}</b> 个条目`,
                   `<b>${state.items.length}</b> 张图片`, kb(bytes)];
    stat.innerHTML = parts.join(' · ');
    zipBtn.disabled = state.items.length === 0;
    noimg.classList.toggle('hidden', state.items.length !== 0 || pkgs.length === 0);
  }

  async function addPkg(file, pkg) {
    const entryRows = [];
    for (const e of pkg.entries) {
      const lower = e.name.toLowerCase();
      let note = '';
      let count = 0;
      if (lower.endsWith('.tex')) {
        const bytes = WE.entrySlice(pkg, e);
        const imgs = WE.findImages(bytes, 0, bytes.length);
        count = imgs.length;
        if (!imgs.length) {
          const fmt = WE.texFormat(bytes);
          note = fmt ? `${fmt} · 无 PNG/JPG 负载，暂不支持` : '未知贴图格式';
        } else {
          const basePath = e.name.replace(/\.tex$/i, '');
          const dir = basePath.includes('/') ? basePath.slice(0, basePath.lastIndexOf('/') + 1) : '';
          const stem = basePath.slice(basePath.lastIndexOf('/') + 1);
          const types = { png: 0, jpg: 0 };
          for (let k = 0; k < imgs.length; k++) {
            const im = imgs[k];
            types[im.type]++;
            const blob = new Blob([bytes.slice(im.start, im.end)],
              { type: im.type === 'png' ? 'image/png' : 'image/jpeg' });
            const d = await dims(blob);
            const suffix = imgs.length > 1 ? `_mip${k}` : '';
            const ext = im.type === 'png' ? 'png' : 'jpg';
            const fname = uniqueName(`${stem}${suffix}.${ext}`);
            state.items.push({
              name: `${stem}${suffix}`,
              path: `${dir}${stem}${suffix}.${ext}`,
              filename: fname,
              blob, mip: k, type: im.type,
              w: d.w, h: d.h,
              url: d.url,
            });
          }
          const parts = [];
          if (types.png) parts.push(`PNG × ${types.png}`);
          if (types.jpg) parts.push(`JPG × ${types.jpg}`);
          note = parts.join(' + ');
        }
      }
      entryRows.push({ name: e.name, size: e.size, note, count });
    }

    state.pkgs.push({ file, ...pkg });
    // entries list
    if (state.pkgs.length === 1) entryList.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'pkghead';
    head.textContent = `${file.name} · ${pkg.magic} · ${pkg.entries.length} 个条目`;
    entryList.appendChild(head);
    for (const r of entryRows) {
      const row = document.createElement('div');
      row.className = 'entry';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = r.name;
      nm.title = r.name;
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = r.note;
      const sz = document.createElement('span');
      sz.className = 'sz';
      sz.textContent = kb(r.size);
      row.append(nm, tag, sz);
      entryList.appendChild(row);
    }
    entryCount.textContent = `(${state.pkgs.reduce((a, p) => a + p.entries.length, 0)})`;

    // gallery: append new cards, keep newest first overall
    const fresh = state.items.slice(-entryRows.filter(r => r.count).reduce((a, r) => a + r.count, 0));
    for (const item of fresh) gallery.appendChild(card(item));
    result.classList.remove('hidden');
    renderMeta();
  }

  async function handleFiles(files) {
    const list = Array.from(files).filter(f => /\.pkg$/i.test(f.name));
    if (!list.length) { toast('请选择 .pkg 文件（Wallpaper Engine 场景包）。', true); return; }
    for (const file of list) {
      try {
        const bytes = new Uint8Array(await file.arrayBuffer());
        const pkg = WE.parsePkg(bytes);
        await addPkg(file, pkg);
        toast(`已解析 ${file.name}`);
      } catch (err) {
        console.error(err);
        toast(`${file.name}：${err.message || '解析失败'}`, true);
      }
    }
  }

  drop.addEventListener('click', ev => {
    if (ev.target === fileInput) return;
    fileInput.click();
  });
  fileInput.addEventListener('change', () => {
    if (fileInput.files.length) handleFiles(fileInput.files);
    fileInput.value = '';
  });

  ['dragenter', 'dragover'].forEach(t => drop.addEventListener(t, ev => {
    ev.preventDefault();
    drop.classList.add('drag');
  }));
  ['dragleave', 'drop'].forEach(t => drop.addEventListener(t, ev => {
    ev.preventDefault();
    if (t === 'dragleave' && drop.contains(ev.relatedTarget)) return;
    drop.classList.remove('drag');
  }));
  drop.addEventListener('drop', ev => {
    if (ev.dataTransfer && ev.dataTransfer.files.length) handleFiles(ev.dataTransfer.files);
  });
  window.addEventListener('dragover', ev => ev.preventDefault());
  window.addEventListener('drop', ev => ev.preventDefault());

  zipBtn.addEventListener('click', () => {
    if (!state.items.length) return;
    Promise.all(state.items.map(async it => ({
      name: it.path,
      data: new Uint8Array(await it.blob.arrayBuffer()),
    }))).then(list => {
      const zip = WE.makeZip(list);
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;
      saveBlob(new Blob([zip], { type: 'application/zip' }), `pkg-png-${stamp}.zip`);
      toast(`已打包 ${list.length} 张 PNG`);
    }).catch(err => { console.error(err); toast('打包失败：' + err.message, true); });
  });

  resetBtn.addEventListener('click', () => {
    for (const it of state.items) if (it.url) URL.revokeObjectURL(it.url);
    state.items = [];
    state.pkgs = [];
    state.names.clear();
    gallery.innerHTML = '';
    entryList.innerHTML = '';
    entryCount.textContent = '';
    result.classList.add('hidden');
    $('#entriesBox').open = false;
    renderMeta();
  });

  $('#lightbox').addEventListener('click', ev => {
    if (ev.target.id === 'lightbox' || ev.target.id === 'lbClose') {
      $('#lightbox').classList.remove('open');
      $('#lbImg').src = '';
    }
  });
  document.addEventListener('keydown', ev => {
    if (ev.key === 'Escape') {
      $('#lightbox').classList.remove('open');
      $('#lbImg').src = '';
    }
  });

})();
