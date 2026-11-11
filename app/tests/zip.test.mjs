// 실행: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { ZipWriter, readZip, crc32 } from '../js/zip.js';
import { buildBundle, importBundle } from '../js/bundle.js';
import { blankDoc } from '../js/docs.js';
import * as db from '../js/store.js';        // Node 에는 indexedDB 가 없어서 메모리 저장소로 동작한다

const enc = new TextEncoder();

test('CRC32 표준 검사값', () => {
  assert.equal(crc32(enc.encode('123456789')), 0xcbf43926);
  assert.equal(crc32(new Uint8Array(0)), 0);
  assert.equal(crc32(enc.encode('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('ZIP 왕복: 한글 이름, 이진 데이터, 빈 파일, 하위 폴더', async () => {
  const bin = new Uint8Array(70000).map((_, i) => (i * 31 + 7) & 0xff);
  const w = new ZipWriter();
  await w.add('목록.csv', '\uFEFF시험일,번호\r\n2026-11-10,1\r\n');
  await w.add('2026-11-10/01_테스트 현장 A동_3층 기둥 C5.pdf', bin);
  await w.add('빈파일.txt', new Uint8Array(0));
  await w.add('기록지사진/abc.jpg', new Blob([bin]));
  const blob = w.finish();
  assert.equal(blob.type, 'application/zip');

  const entries = await readZip(blob);
  assert.deepEqual(entries.map((e) => e.name), ['목록.csv', '2026-11-10/01_테스트 현장 A동_3층 기둥 C5.pdf', '빈파일.txt', '기록지사진/abc.jpg']);
  assert.equal(await entries[0].text(), '시험일,번호\r\n2026-11-10,1\r\n');                      // text() 는 맨 앞 BOM 을 떼어 준다 (JSON.parse 가 BOM 에서 실패하므로)
  assert.deepEqual([...(await entries[0].bytes()).slice(0, 3)], [0xef, 0xbb, 0xbf]);             // 파일 안에는 BOM 이 그대로 있다 (엑셀용)
  assert.deepEqual(await entries[1].bytes(), bin);
  assert.equal((await entries[2].bytes()).length, 0);
  assert.deepEqual(await entries[3].bytes(), bin);
});

test('ZIP: 한글 이름에 UTF-8 플래그(bit 11)가 켜져 있다', async () => {
  const w = new ZipWriter();
  await w.add('한글.txt', 'x');
  const bytes = new Uint8Array(await w.finish().arrayBuffer());
  const dv = new DataView(bytes.buffer);
  assert.equal(dv.getUint32(0, true), 0x04034b50);          // 로컬 헤더
  assert.equal(dv.getUint16(6, true) & 0x0800, 0x0800);
});

test('ZIP: 손상(데이터 변조)과 ZIP 이 아닌 파일을 알아챈다', async () => {
  const w = new ZipWriter();
  await w.add('a.bin', new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]));
  const bytes = new Uint8Array(await w.finish().arrayBuffer());
  bytes[30 + 'a.bin'.length + 2] ^= 0xff;                      // 데이터 한 바이트 변조
  const [e] = await readZip(bytes);
  await assert.rejects(() => e.bytes(), /손상/);
  await assert.rejects(() => readZip(enc.encode('hello world, not a zip file at all')), /ZIP/);
});

/** 다른 프로그램(예: 탐색기 "압축")이 만든 ZIP 을 흉내: deflate(method 8) 항목 한 개짜리 ZIP 을 직접 만든다 */
function deflateZip(nameStr, raw) {
  const deflated = zlib.deflateRawSync(raw);
  const name = enc.encode(nameStr);
  const crc = crc32(raw);
  const lh = new DataView(new ArrayBuffer(30));
  lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint16(6, 0x0800, true); lh.setUint16(8, 8, true);
  lh.setUint32(14, crc, true); lh.setUint32(18, deflated.length, true); lh.setUint32(22, raw.length, true); lh.setUint16(26, name.length, true);
  const cd = new DataView(new ArrayBuffer(46));
  cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(10, 8, true);
  cd.setUint32(16, crc, true); cd.setUint32(20, deflated.length, true); cd.setUint32(24, raw.length, true); cd.setUint16(28, name.length, true); cd.setUint32(42, 0, true);
  const cdStart = 30 + name.length + deflated.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, 1, true); end.setUint16(10, 1, true); end.setUint32(12, 46 + name.length, true); end.setUint32(16, cdStart, true);
  return new Uint8Array([...new Uint8Array(lh.buffer), ...name, ...deflated, ...new Uint8Array(cd.buffer), ...name, ...new Uint8Array(end.buffer)]);
}

test('ZIP 읽기: 다른 도구가 만든 deflate 압축 항목도 읽는다', async () => {
  const zip = deflateZip('데이터.json', enc.encode('가나다라마바사 '.repeat(500)));
  const entries = await readZip(zip);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, '데이터.json');
  assert.equal(await entries[0].text(), '가나다라마바사 '.repeat(500));
});

test('ZIP 읽기: 브라우저가 deflate-raw 를 모르면(옛 Safari) 한국어 오류로 알린다', async () => {
  const zip = deflateZip('데이터.json', enc.encode('가나다라마바사 '.repeat(50)));
  const Orig = globalThis.DecompressionStream;
  try {
    // 'deflate-raw' 형식을 모르는 DecompressionStream: 생성자가 TypeError
    globalThis.DecompressionStream = class { constructor(format) { throw new TypeError(`Unsupported compression format: '${format}'`); } };
    const [e1] = await readZip(zip);
    await assert.rejects(() => e1.bytes(), /이 브라우저는 압축된 ZIP 을 읽을 수 없습니다/);
    // DecompressionStream 자체가 없는 브라우저
    delete globalThis.DecompressionStream;
    const [e2] = await readZip(zip);
    await assert.rejects(() => e2.bytes(), /이 브라우저는 압축된 ZIP 을 읽을 수 없습니다/);
  } finally {
    globalThis.DecompressionStream = Orig;
  }
  // 무압축(stored) ZIP 은 DecompressionStream 이 없어도 읽는다 (이 앱이 내보낸 ZIP)
  const w = new ZipWriter();
  await w.add('a.txt', '무압축 항목');
  const saved = globalThis.DecompressionStream;
  delete globalThis.DecompressionStream;
  try {
    const [e3] = await readZip(w.finish());
    assert.equal(await e3.text(), '무압축 항목');
  } finally {
    globalThis.DecompressionStream = saved;
  }
});

test('ZIP 읽기: macOS/아이폰이 다시 압축한 NFD(자모 분리) 한글 이름도 NFC 로 읽는다', async () => {
  const nfd = (s) => s.normalize('NFD');
  assert.notEqual(nfd('데이터.json'), '데이터.json');                          // 글자 그대로는 다른 문자열
  const w = new ZipWriter();
  await w.add(nfd('데이터.json'), '{}');
  await w.add(nfd('2026-11-10/01_현장_기록지.jpg'), new Uint8Array([1, 2, 3]));
  const entries = await readZip(w.finish());
  assert.deepEqual(entries.map((e) => e.name), ['데이터.json', '2026-11-10/01_현장_기록지.jpg']);   // === 로 NFC 문자열과 같다
});

test('가져오기: 아이폰 파일 앱이 다시 압축해 한글 이름이 NFD 가 된 ZIP 도 문서·사진을 가져온다', async () => {
  const jpeg = (n) => new Blob([new Uint8Array(n).fill(0xd8)], { type: 'image/jpeg' });
  const doc = blankDoc({
    id: 'nfd-test-1', site: '테스트 현장', location: '208동 15층 벽체', testDate: '2026-11-10',
    values: Array.from({ length: 20 }, (_, i) => 40 + i),
    photo: { rotation: 0, width: 100, height: 80, boxes: {} },
    shots: [{ id: 's1', width: 10, height: 10 }, { id: 's2', width: 10, height: 10 }],
  });
  await db.putDoc(doc, jpeg(300));
  await db.putShot(doc.id, 's1', jpeg(111));
  await db.putShot(doc.id, 's2', jpeg(222));
  const { blob } = await buildBundle([doc], { pdf: false, photos: true });
  const original = await readZip(blob);
  assert.ok(original.some((e) => e.name === '데이터.json'));

  // 같은 내용을 한글 이름만 NFD 로 바꿔 다시 묶는다 (파일 앱의 [압축])
  const w = new ZipWriter();
  for (const e of original) await w.add(e.name.normalize('NFD'), await e.bytes());
  const rezipped = new File([w.finish()], '슈미트해머_재압축.zip', { type: 'application/zip' });

  await db.removeDocs([doc.id]);
  const r = await importBundle(rezipped);
  assert.equal(r.added, 1);
  assert.equal(r.invalid, 0);
  assert.equal(r.photos, 3);                                                  // 기록지 사진 1장 + 사진대지 사진 2장
  assert.equal((await db.getPhoto(doc.id)).size, 300);
  assert.equal((await db.getShot(doc.id, 's1')).size, 111);
  assert.equal((await db.getShot(doc.id, 's2')).size, 222);
  assert.deepEqual((await db.getDoc(doc.id)).shots.map((s) => s.id), ['s1', 's2']);
  await db.removeDocs([doc.id]);
});
