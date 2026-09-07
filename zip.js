// Minimal ZIP writer (store / no compression). PNG and JPEG are already
// compressed, so deflating them buys nothing and costs a dependency.
(() => {
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[i] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // DOS date/time, the format ZIP has used since 1989.
  function dosTime(d = new Date()) {
    const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
    const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
    return { time, date };
  }

  const enc = new TextEncoder();

  function view(len) {
    const buf = new ArrayBuffer(len);
    return { buf, dv: new DataView(buf), u8: new Uint8Array(buf) };
  }

  // entries: [{ name, bytes: Uint8Array }]
  function makeZip(entries) {
    const { time, date } = dosTime();
    const parts = [];
    const central = [];
    let offset = 0;

    for (const e of entries) {
      const name = enc.encode(e.name);
      const crc = crc32(e.bytes);
      const size = e.bytes.length;

      const lh = view(30);
      lh.dv.setUint32(0, 0x04034b50, true); // local file header
      lh.dv.setUint16(4, 20, true);         // version needed
      lh.dv.setUint16(6, 0x0800, true);     // UTF-8 names
      lh.dv.setUint16(8, 0, true);          // method: store
      lh.dv.setUint16(10, time, true);
      lh.dv.setUint16(12, date, true);
      lh.dv.setUint32(14, crc, true);
      lh.dv.setUint32(18, size, true);
      lh.dv.setUint32(22, size, true);
      lh.dv.setUint16(26, name.length, true);
      lh.dv.setUint16(28, 0, true);
      parts.push(lh.u8, name, e.bytes);

      const ch = view(46);
      ch.dv.setUint32(0, 0x02014b50, true); // central directory header
      ch.dv.setUint16(4, 20, true);
      ch.dv.setUint16(6, 20, true);
      ch.dv.setUint16(8, 0x0800, true);
      ch.dv.setUint16(10, 0, true);
      ch.dv.setUint16(12, time, true);
      ch.dv.setUint16(14, date, true);
      ch.dv.setUint32(16, crc, true);
      ch.dv.setUint32(20, size, true);
      ch.dv.setUint32(24, size, true);
      ch.dv.setUint16(28, name.length, true);
      ch.dv.setUint32(42, offset, true);    // offset of local header
      central.push(ch.u8, name);

      offset += 30 + name.length + size;
    }

    const centralSize = central.reduce((n, p) => n + p.length, 0);
    const eocd = view(22);
    eocd.dv.setUint32(0, 0x06054b50, true); // end of central directory
    eocd.dv.setUint16(8, entries.length, true);
    eocd.dv.setUint16(10, entries.length, true);
    eocd.dv.setUint32(12, centralSize, true);
    eocd.dv.setUint32(16, offset, true);

    return new Blob([...parts, ...central, eocd.u8], { type: "application/zip" });
  }

  self.makeZip = makeZip;
})();
