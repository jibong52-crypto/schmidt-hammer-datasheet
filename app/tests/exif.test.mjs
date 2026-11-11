// 실행: node --test tests/exif.test.mjs      (js/exif.js: JPEG EXIF 방향·촬영일·원본 크기 읽기)
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseExif, readExif, exifDateToYmd, exifPhotoDate, orientTransform, EXIF_HEAD_BYTES } from '../js/exif.js';

const u16 = (v, le) => (le ? [v & 255, v >> 8] : [v >> 8, v & 255]);
const u32 = (v, le) => (le ? [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255] : [(v >>> 24) & 255, (v >> 16) & 255, (v >> 8) & 255, v & 255]);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

/**
 * 합성 JPEG: SOI + APP1(Exif) + SOF0 + EOI.
 * o: 방향값(0 이면 태그 없음), date: DateTimeOriginal, ifd0Date: IFD0 DateTime, W/H: SOF 크기
 */
function jpeg({ o = 6, le = true, date = null, ifd0Date = null, W = 40, H = 30, exif = true, extra = null, tweak = null } = {}) {
  const parts = [[0xFF, 0xD8]];
  if (exif) {
    // IFD0 항목: [tag, type, count, value-bytes(4)] / 큰 값은 데이터 영역에 둔다
    const dateBytes = (s) => [...ascii(s), 0];
    const ifd0 = [];                                   // {tag,type,count,val|data}
    if (o) ifd0.push({ tag: 0x0112, type: 3, count: 1, val: [...u16(o, le), 0, 0] });
    if (ifd0Date) ifd0.push({ tag: 0x0132, type: 2, count: 20, data: dateBytes(ifd0Date) });
    if (date) ifd0.push({ tag: 0x8769, type: 4, count: 1, exifPtr: true });
    const n0 = ifd0.length;
    const ifd0Size = 2 + n0 * 12 + 4;
    let dataOff = 8 + ifd0Size;
    const data = [];
    const exifIfdOff = dataOff;                         // ExifIFD 를 데이터 영역 맨 앞에 둔다
    let exifIfd = [];
    if (date) {
      const dOff = exifIfdOff + 2 + 12 + 4;
      exifIfd = [...u16(1, le), ...u16(0x9003, le), ...u16(2, le), ...u32(20, le), ...u32(dOff, le), ...u32(0, le), ...dateBytes(date)];
      data.push(...exifIfd);
    }
    dataOff += data.length;
    const body = [];
    for (const e of ifd0) {
      let val;
      if (e.exifPtr) val = u32(exifIfdOff, le);
      else if (e.data) { val = u32(dataOff, le); data.push(...e.data); dataOff += e.data.length; }
      else val = e.val;
      body.push(...u16(e.tag, le), ...u16(e.type, le), ...u32(e.count, le), ...val);
    }
    let tiff = [...(le ? [0x49, 0x49] : [0x4D, 0x4D]), ...u16(42, le), ...u32(8, le), ...u16(n0, le), ...body, ...u32(0, le), ...data];
    if (tweak) tiff = tweak(tiff, le);
    const payload = [...ascii('Exif'), 0, 0, ...tiff];
    parts.push([0xFF, 0xE1, ...u16(payload.length + 2, false), ...payload]);
  }
  if (extra) parts.push(extra);
  // SOF0: 길이 17(3성분), 정밀도 8, 높이, 너비
  parts.push([0xFF, 0xC0, 0, 17, 8, ...u16(H, false), ...u16(W, false), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  parts.push([0xFF, 0xD9]);
  return Uint8Array.from(parts.flat());
}

test('방향 1~8, 리틀/빅 엔디안 모두 읽는다 + SOF 원본 크기', () => {
  for (const le of [true, false]) {
    for (let o = 1; o <= 8; o++) {
      const r = parseExif(jpeg({ o, le, W: 40, H: 30 }));
      assert.equal(r.orientation, o, `o=${o} le=${le}`);
      assert.deepEqual(r.sof, { width: 40, height: 30 });
    }
  }
});

test('DateTimeOriginal(ExifIFD) 우선, 없으면 IFD0 DateTime', () => {
  for (const le of [true, false]) {
    let r = parseExif(jpeg({ le, date: '2026:08:03 14:05:09' }));
    assert.equal(r.dateTime, '2026:08:03 14:05:09');
    assert.equal(r.orientation, 6);
    r = parseExif(jpeg({ le, ifd0Date: '2025:12:31 23:59:59' }));
    assert.equal(r.dateTime, '2025:12:31 23:59:59');
    r = parseExif(jpeg({ le, date: '2026:08:03 14:05:09', ifd0Date: '2020:01:01 00:00:00' }));
    assert.equal(r.dateTime, '2026:08:03 14:05:09');
  }
});

test('EXIF 없음 / 방향 태그 없음', () => {
  const a = parseExif(jpeg({ exif: false }));
  assert.equal(a.orientation, 0);
  assert.equal(a.dateTime, null);
  assert.deepEqual(a.sof, { width: 40, height: 30 });
  const b = parseExif(jpeg({ o: 0, date: '2026:08:03 10:00:00' }));
  assert.equal(b.orientation, 0);
  assert.equal(b.dateTime, '2026:08:03 10:00:00');
});

test('범위 밖 방향값(0, 9)은 0 으로 본다', () => {
  assert.equal(parseExif(jpeg({ o: 9 })).orientation, 0);
});

test('JPEG 가 아니면 null (PNG, 빈 입력, 짧은 입력)', () => {
  const png = Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 13]);
  assert.equal(parseExif(png), null);
  assert.equal(parseExif(new Uint8Array(0)), null);
  assert.equal(parseExif(Uint8Array.from([0xFF, 0xD8])), null);
  assert.equal(parseExif(null), null);
});

test('잘린 파일: 어디서 잘라도 예외 없이 끝난다', () => {
  const full = jpeg({ o: 6, date: '2026:08:03 14:05:09', ifd0Date: '2026:08:03 14:05:09' });
  for (let n = 0; n <= full.length; n++) {
    const r = parseExif(full.subarray(0, n));
    if (r) assert.ok(r.orientation >= 0 && r.orientation <= 8);
  }
  // 방향 항목까지 들어있는 정도로 자르면 방향은 읽힌다
  assert.equal(parseExif(full.subarray(0, 40)).orientation, 6);
});

test('엉뚱한 오프셋(범위 밖 IFD0 / ExifIFD / 문자열 포인터)에도 헛돌거나 예외 없이 끝난다', () => {
  const evil = [
    // IFD0 오프셋이 파일 밖
    (t, le) => { t.splice(4, 4, ...u32(0x7FFFFFFF, le)); return t; },
    // IFD0 오프셋 = 0xFFFFFFFF
    (t, le) => { t.splice(4, 4, ...u32(0xFFFFFFFF, le)); return t; },
    // IFD0 오프셋이 헤더 안쪽(자기 자신 가리킴)
    (t, le) => { t.splice(4, 4, ...u32(0, le)); return t; },
    // 항목 수를 크게
    (t, le) => { t.splice(8, 2, ...u16(65535, le)); return t; },
    // 맨 앞 항목(방향)의 type/count 를 이상하게
    (t, le) => { t.splice(12, 8, ...u16(3, le), ...u16(0xFFFF, le), ...u32(0xFFFFFFFF, le)); return t; },
    // 모든 바이트를 0xFF 로
    (t) => t.map(() => 0xFF),
  ];
  for (const tweak of evil) {
    const r = parseExif(jpeg({ date: '2026:08:03 14:05:09', ifd0Date: '2026:08:03 14:05:09', tweak }));
    assert.ok(r === null || (r.orientation >= 0 && r.orientation <= 8));
  }
  // 날짜 포인터가 범위 밖 → 날짜 무시, 방향은 살아 있다
  const r = parseExif(jpeg({ date: '2026:08:03 14:05:09', tweak: (t, le) => {
    // ExifIFD 안의 날짜 오프셋(항목 +8)을 범위 밖으로
    const exifIfdAt = 8 + 2 + 2 * 12 + 4;           // IFD0: 방향 + ExifIFD포인터 → 항목 2개
    t.splice(exifIfdAt + 2 + 8, 4, ...u32(0x00FFFFFF, le));
    return t;
  } }));
  assert.equal(r.orientation, 6);
  assert.equal(r.dateTime, null);
});

test('깨진 마커 / 길이 0 / 마커가 끝없이 이어지는 입력', () => {
  assert.doesNotThrow(() => parseExif(Uint8Array.from([0xFF, 0xD8, 0xFF, 0xE1, 0, 0, 0, 0, 0, 0])));
  assert.doesNotThrow(() => parseExif(Uint8Array.from([0xFF, 0xD8, ...new Array(500).fill(0xFF)])));
  assert.doesNotThrow(() => parseExif(Uint8Array.from([0xFF, 0xD8, ...new Array(300).fill([0xFF, 0xD0]).flat()])));
  // APP1 길이가 파일보다 훨씬 큼
  const x = jpeg({ o: 3 }); x[4] = 0xFF; x[5] = 0xFF;
  assert.doesNotThrow(() => parseExif(x));
  // 앞에 다른 세그먼트(APP0, APP2)가 있어도 EXIF 를 찾는다
  const withApp0 = jpeg({ o: 8, extra: [0xFF, 0xE2, 0, 6, 1, 2, 3, 4] });
  assert.equal(parseExif(withApp0).orientation, 8);
});

test('readExif: Blob 앞 128KB 만 읽는다 / 읽기 실패는 null', async () => {
  const j = jpeg({ o: 6, date: '2026:08:03 14:05:09' });
  const blob = new Blob([j, new Uint8Array(EXIF_HEAD_BYTES * 2)]);
  const r = await readExif(blob);
  assert.equal(r.orientation, 6);
  assert.equal(await readExif(new Blob([Uint8Array.from([1, 2, 3, 4, 5])])), null);
  assert.equal(await readExif(null), null);
  assert.equal(await readExif({ slice() { throw new Error('x'); } }), null);
  assert.equal(await exifPhotoDate(new Blob([j])), '2026-08-03');
  assert.equal(await exifPhotoDate(new Blob([jpeg({ exif: false })])), null);
});

test('exifDateToYmd: 형식·범위 검증', () => {
  const now = new Date(2026, 10, 11, 12).getTime();
  assert.equal(exifDateToYmd('2026:08:03 14:05:09', now), '2026-08-03');
  assert.equal(exifDateToYmd('2026:11:12 01:00:00', now), '2026-11-12');   // 현재+1일까지 허용
  assert.equal(exifDateToYmd('2026:11:13 01:00:00', now), null);            // 미래
  assert.equal(exifDateToYmd('1989:12:31 00:00:00', now), null);            // 1990 이전
  assert.equal(exifDateToYmd('1990:01:01 00:00:00', now), '1990-01-01');
  assert.equal(exifDateToYmd('2026:02:30 00:00:00', now), null);            // 없는 날짜
  assert.equal(exifDateToYmd('2026:13:01 00:00:00', now), null);
  assert.equal(exifDateToYmd('2026:00:10 00:00:00', now), null);
  assert.equal(exifDateToYmd('2026:05:00 00:00:00', now), null);
  assert.equal(exifDateToYmd('0000:00:00 00:00:00', now), null);
  assert.equal(exifDateToYmd('    :  :     :  :  ', now), null);
  assert.equal(exifDateToYmd('', now), null);
  assert.equal(exifDateToYmd(null, now), null);
  assert.equal(exifDateToYmd('2024:02:29 10:00:00', now), '2024-02-29');
  assert.equal(exifDateToYmd('2025:02:29 10:00:00', now), null);
});

test('orientTransform: 원본 모서리가 EXIF 규칙대로 옮겨진다', () => {
  const w = 4, h = 2;
  const map = (t, x, y) => [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];
  // 원본 좌상단(0,0) → 화면에서의 위치. 표: EXIF 규격 (0th row, 0th column) 의미
  const TL = { 1: 'TL', 2: 'TR', 3: 'BR', 4: 'BL', 5: 'TL', 6: 'TR', 7: 'BR', 8: 'BL' };
  for (let o = 1; o <= 8; o++) {
    const t = orientTransform(o, w, h);
    const swap = o >= 5;
    assert.equal(t.width, swap ? h : w);
    assert.equal(t.height, swap ? w : h);
    const [x, y] = map(t, 0, 0);
    const got = (y === 0 ? 'T' : 'B') + (x === 0 ? 'L' : 'R');
    assert.equal(got, TL[o], `o=${o} 좌상단`);
    // 네 모서리 모두 캔버스 안
    for (const [px, py] of [[0, 0], [w, 0], [0, h], [w, h]]) {
      const [qx, qy] = map(t, px, py);
      assert.ok(qx >= 0 && qx <= t.width && qy >= 0 && qy <= t.height, `o=${o} (${px},${py})→(${qx},${qy})`);
    }
  }
  // 6: 시계방향 90도 — 원본 우상단(4,0) → 화면 우하단
  const t6 = orientTransform(6, w, h);
  assert.deepEqual(map(t6, w, 0), [h, w]);
  // 8: 반시계방향 90도 — 원본 우상단 → 화면 좌상단
  assert.deepEqual(map(orientTransform(8, w, h), w, 0), [0, 0]);
  // 알 수 없는 값은 그대로
  assert.deepEqual(orientTransform(0, w, h), { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, width: w, height: h });
});
