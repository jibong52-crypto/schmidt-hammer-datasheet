// 아주 작은 JPEG EXIF 읽기 (의존성 없음): 회전 방향(Orientation), 촬영일(DateTimeOriginal), JPEG 원본 크기(SOF).
// 아이폰 사진은 픽셀이 가로로 저장되고 EXIF 방향값(6 등)만 붙어 있는 경우가 많다.

/** EXIF 를 찾을 때 파일 앞에서 읽는 바이트 수 (APP1 은 최대 64KB, SOF 마커는 그 뒤 바로 나온다) */
export const EXIF_HEAD_BYTES = 131072;

const MAX_ENTRIES = 512;        // IFD 하나에서 읽을 항목 상한 (깨진 파일에서 헛돌지 않게)
const MAX_SEGMENTS = 64;        // JPEG 마커 순회 상한

const asBytes = (buf) => (buf instanceof Uint8Array ? buf : new Uint8Array(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength));

/**
 * JPEG 바이트에서 EXIF 정보를 읽는다. 읽지 못하는 부분은 비워 둔다 (예외를 던지지 않는다).
 * @param {Uint8Array|ArrayBuffer} buf  파일 앞부분
 * @returns {null | {orientation:number, dateTime:string|null, sof:{width:number,height:number}|null}}
 *   JPEG 가 아니면 null. orientation 은 1~8, 모르면 0.
 */
export function parseExif(buf) {
  let b;
  try { b = asBytes(buf); } catch { return null; }
  const n = b.length;
  if (n < 4 || b[0] !== 0xFF || b[1] !== 0xD8) return null;      // JPEG 가 아님 (PNG 등)
  const out = { orientation: 0, dateTime: null, sof: null };
  let exifDone = false;
  let p = 2;
  for (let seg = 0; seg < MAX_SEGMENTS && p + 4 <= n; seg++) {
    if (b[p] !== 0xFF) break;                                    // 마커가 아니면 중단 (깨진 파일)
    while (p < n && b[p] === 0xFF) p++;                          // 채움 바이트(FF FF …) 건너뜀
    const m = b[p++];
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7)) continue;               // 길이 없는 마커
    if (m === 0xD9 || m === 0xDA) break;                         // EOI / SOS: 이미지 데이터 시작
    if (p + 2 > n) break;
    const len = (b[p] << 8) | b[p + 1];
    if (len < 2) break;
    const body = p + 2, end = p + len;                           // body: 길이 필드 다음, end: 이 세그먼트 끝(배타)
    if (m === 0xE1 && !exifDone && body + 6 <= n && b[body] === 0x45 && b[body + 1] === 0x78 && b[body + 2] === 0x69 && b[body + 3] === 0x66 && b[body + 4] === 0 && b[body + 5] === 0) {
      exifDone = true;
      try { readTiff(b, body + 6, Math.min(end, n), out); } catch { /* 깨진 EXIF 는 무시 */ }
    } else if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      if (body + 5 <= n) {
        const height = (b[body + 1] << 8) | b[body + 2], width = (b[body + 3] << 8) | b[body + 4];
        if (width > 0 && height > 0) out.sof = { width, height };
      }
      break;                                                     // SOF 를 읽었으면 EXIF 는 이미 앞에서 나왔다
    }
    p = end;
  }
  return out;
}

/** TIFF 헤더(II/MM) 이하를 읽어 out 에 채운다. lim: 읽어도 되는 끝(배타) */
function readTiff(b, t, lim, out) {
  if (t + 8 > lim) return;
  const le = b[t] === 0x49 && b[t + 1] === 0x49;
  if (!le && !(b[t] === 0x4D && b[t + 1] === 0x4D)) return;
  const u16 = (o) => (o >= 0 && o + 2 <= lim ? (le ? b[o] | (b[o + 1] << 8) : (b[o] << 8) | b[o + 1]) : -1);
  const u32 = (o) => (o >= 0 && o + 4 <= lim
    ? (le ? (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) : ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3])) >>> 0
    : -1);
  if (u16(t + 2) !== 42) return;

  /** IFD 하나의 항목을 순회: cb(tag, type, count, valueOffsetAbs) — 값이 4바이트 이하면 항목 안(e+8), 아니면 포인터를 따라간 위치 */
  const walk = (ifdRel, cb) => {
    const ifd = t + ifdRel;
    if (ifdRel < 8 || ifd + 2 > lim) return;
    const cnt = Math.min(u16(ifd), MAX_ENTRIES);
    for (let i = 0; i < cnt; i++) {
      const e = ifd + 2 + i * 12;
      if (e + 12 > lim) return;
      const tag = u16(e), type = u16(e + 2), count = u32(e + 4);
      const size = ({ 1: 1, 2: 1, 3: 2, 4: 4, 7: 1 })[type] ?? 0;
      let at = e + 8;
      if (size && count * size > 4) {
        const rel = u32(e + 8);
        if (rel < 0 || t + rel + count * size > lim) continue;   // 범위 밖 포인터는 무시
        at = t + rel;
      }
      cb(tag, type, count, at, e);
    }
  };
  const ascii = (at, count) => {
    let s = '';
    for (let i = 0; i < count && at + i < lim; i++) { const c = b[at + i]; if (!c) break; s += String.fromCharCode(c); }
    return s;
  };

  let exifIfd = 0, ifd0Date = null;
  walk(u32(t + 4), (tag, type, count, at) => {
    if (tag === 0x0112 && type === 3 && count >= 1) { const v = u16(at); if (v >= 1 && v <= 8) out.orientation = v; }
    else if (tag === 0x8769 && type === 4) exifIfd = u32(at);
    else if (tag === 0x0132 && type === 2) ifd0Date = ascii(at, count);
  });
  let original = null;
  if (exifIfd > 0) walk(exifIfd, (tag, type, count, at) => { if (tag === 0x9003 && type === 2) original = ascii(at, count); });
  out.dateTime = original || ifd0Date || null;
}

/** 파일/Blob 앞부분만 읽어 EXIF 를 파싱한다. JPEG 가 아니거나 읽기 실패면 null. */
export async function readExif(blob) {
  try {
    if (!blob || typeof blob.slice !== 'function') return null;
    const head = blob.slice(0, EXIF_HEAD_BYTES);
    const buf = typeof head.arrayBuffer === 'function' ? await head.arrayBuffer() : await new Response(head).arrayBuffer();
    return parseExif(new Uint8Array(buf));
  } catch {
    return null;
  }
}

/**
 * EXIF 시각 문자열 'YYYY:MM:DD HH:MM:SS' → 'YYYY-MM-DD' (docs.js 의 todayStr 과 같은 형식). 이상하면 null.
 * 범위: 1990년 이후 ~ 지금 + 1일 (기기 현지 시각이므로 시간대 어긋남 1일 허용).
 */
export function exifDateToYmd(s, now = Date.now()) {
  const m = /^\s*(\d{4})[:\-/](\d{2})[:\-/](\d{2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?/.exec(String(s ?? ''));
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 1990 || mo < 1 || mo > 12 || d < 1) return null;
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;   // 2월 30일 등
  if (dt.getTime() > now + 86400000) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** 원본 파일에서 촬영일('YYYY-MM-DD')을 읽는다. 없거나 이상하면 null. */
export async function exifPhotoDate(file) {
  const ex = await readExif(file);
  return ex ? exifDateToYmd(ex.dateTime) : null;
}

/**
 * EXIF 방향값 o(1~8) 를 화면 방향으로 돌리는 캔버스 변환.
 * 원본 w×h 를 그대로 그릴 때 ctx.setTransform(a,b,c,d,e,f) 를 쓰면 width×height 캔버스에 올바른 방향으로 그려진다.
 */
export function orientTransform(o, w, h) {
  const swap = o >= 5 && o <= 8;
  const t = ({
    1: [1, 0, 0, 1, 0, 0],
    2: [-1, 0, 0, 1, w, 0],      // 좌우 반전
    3: [-1, 0, 0, -1, w, h],     // 180도
    4: [1, 0, 0, -1, 0, h],      // 상하 반전
    5: [0, 1, 1, 0, 0, 0],       // 대각선(transpose)
    6: [0, 1, -1, 0, h, 0],      // 시계방향 90도
    7: [0, -1, -1, 0, h, w],     // transverse
    8: [0, -1, 1, 0, 0, w],      // 반시계방향 90도
  })[o] ?? [1, 0, 0, 1, 0, 0];
  return { a: t[0], b: t[1], c: t[2], d: t[3], e: t[4], f: t[5], width: swap ? h : w, height: swap ? w : h };
}
