// 아주 작은 ZIP 작성/읽기 (의존성 없음). 내보내기 묶음과 가져오기에 쓴다.
//  · 작성: 압축 없이 저장(stored). PDF/JPEG 는 이미 압축된 형식이라 다시 압축해도 이득이 거의 없다.
//          파일 이름은 UTF-8 로 표시(플래그 bit 11)해서 한글 이름이 윈도우/안드로이드에서 그대로 보인다.
//  · 읽기: stored 와 deflate 를 지원 (deflate 는 브라우저의 DecompressionStream 사용). CRC 로 손상 여부를 확인한다.

const enc = new TextEncoder();
const dec = new TextDecoder('utf-8');

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const dosDate = (d) => ((((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff);

export async function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (typeof data === 'string') return enc.encode(data);
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  throw new TypeError('지원하지 않는 데이터 형식');
}

export class ZipWriter {
  constructor() {
    this.parts = [];
    this.entries = [];
    this.offset = 0;
  }

  /** @param name 경로는 '/' 로 구분 (예: "2026-11-10/01_현장.pdf") */
  async add(name, data, date = new Date()) {
    const bytes = await toBytes(data);
    if (bytes.length >= 0xffffffff || this.offset >= 0xffffffff - bytes.length) throw new Error('ZIP 이 너무 큽니다 (4GB 미만으로 나눠 내보내세요)');
    if (this.entries.length >= 0xffff) throw new Error('ZIP 에 넣을 파일이 너무 많습니다');
    const nameBytes = enc.encode(name);
    const crc = crc32(bytes);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true);
    h.setUint16(4, 20, true);              // 필요한 버전
    h.setUint16(6, 0x0800, true);          // UTF-8 이름
    h.setUint16(8, 0, true);               // stored
    h.setUint16(10, dosTime(date), true);
    h.setUint16(12, dosDate(date), true);
    h.setUint32(14, crc, true);
    h.setUint32(18, bytes.length, true);
    h.setUint32(22, bytes.length, true);
    h.setUint16(26, nameBytes.length, true);
    h.setUint16(28, 0, true);
    this.parts.push(new Uint8Array(h.buffer), nameBytes, bytes);
    this.entries.push({ nameBytes, crc, size: bytes.length, offset: this.offset, time: dosTime(date), date: dosDate(date) });
    this.offset += 30 + nameBytes.length + bytes.length;
  }

  finish() {
    const cdStart = this.offset;
    let cdSize = 0;
    for (const e of this.entries) {
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true);
      c.setUint16(4, 20, true);            // 만든 버전
      c.setUint16(6, 20, true);            // 필요한 버전
      c.setUint16(8, 0x0800, true);
      c.setUint16(10, 0, true);
      c.setUint16(12, e.time, true);
      c.setUint16(14, e.date, true);
      c.setUint32(16, e.crc, true);
      c.setUint32(20, e.size, true);
      c.setUint32(24, e.size, true);
      c.setUint16(28, e.nameBytes.length, true);
      c.setUint32(42, e.offset, true);
      this.parts.push(new Uint8Array(c.buffer), e.nameBytes);
      cdSize += 46 + e.nameBytes.length;
    }
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, this.entries.length, true);
    end.setUint16(10, this.entries.length, true);
    end.setUint32(12, cdSize, true);
    end.setUint32(16, cdStart, true);
    this.parts.push(new Uint8Array(end.buffer));
    return new Blob(this.parts, { type: 'application/zip' });
  }
}

async function inflateRaw(bytes) {
  const unsupported = () => new Error('이 브라우저는 압축된 ZIP 을 읽을 수 없습니다 (이 앱에서 내보낸 ZIP 은 압축하지 않아서 읽을 수 있습니다)');
  if (typeof DecompressionStream === 'undefined') throw unsupported();
  let stream;
  try {
    stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  } catch {
    throw unsupported();                      // Safari 는 버전에 따라 'deflate-raw' 형식을 몰라 TypeError 를 낸다
  }
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** ZIP 을 읽어 항목 목록을 돌려준다. 각 항목: { name, size, bytes(), text() } */
export async function readZip(source) {
  const buf = await toBytes(source);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('ZIP 파일이 아닙니다');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = [];
  for (let k = 0; k < count; k++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('ZIP 목록이 손상되었습니다');
    const method = dv.getUint16(p + 10, true);
    const crc = dv.getUint32(p + 16, true);
    const csize = dv.getUint32(p + 20, true);
    const usize = dv.getUint32(p + 24, true);
    const nlen = dv.getUint16(p + 28, true), elen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    // 항목 이름은 NFC 로 통일한다: macOS/아이폰 파일 앱이 다시 압축한 ZIP 은 한글 이름이 NFD(자모가 갈라진 형태)로 들어 있어
    // 이 앱이 쓰는 이름("데이터.json", "…_기록지.jpg")과 글자 그대로는 같지 않기 때문이다
    const name = dec.decode(buf.subarray(p + 46, p + 46 + nlen)).normalize('NFC');
    p += 46 + nlen + elen + clen;
    entries.push({
      name, size: usize,
      async bytes() {
        if (dv.getUint32(lho, true) !== 0x04034b50) throw new Error('ZIP 항목이 손상되었습니다');
        const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
        const raw = buf.subarray(start, start + csize);
        let out;
        if (method === 0) out = raw.slice();
        else if (method === 8) out = await inflateRaw(raw);
        else throw new Error(`지원하지 않는 압축 방식(${method})`);
        if (crc32(out) !== crc) throw new Error(`ZIP 항목이 손상되었습니다: ${name}`);
        return out;
      },
      async text() { return dec.decode(await this.bytes()); },
    });
  }
  return entries;
}
