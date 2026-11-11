// 실행: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPdf } from '../js/pdf.js';

// 1x1 흰색 JPEG (유효한 최소 JPEG)
const JPEG = Uint8Array.from(Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'));

const latin1 = (u8) => Buffer.from(u8).toString('latin1');

test('PDF 구조: 머리말/쪽 수/xref 오프셋/스트림 길이/끝 표시', () => {
  const pdf = buildPdf([{ jpeg: JPEG, width: 2349, height: 1620 }, { jpeg: JPEG, width: 2349, height: 1620 }], { title: '슈미트해머_테스트' });
  const text = latin1(pdf);
  assert.ok(text.startsWith('%PDF-1.4'));
  assert.ok(text.trimEnd().endsWith('%%EOF'));
  assert.match(text, /\/Count 2/);

  // startxref → xref 표 → 각 객체 오프셋이 실제 "N 0 obj" 위치와 일치해야 한다
  const startxref = Number(/startxref\n(\d+)\n%%EOF/.exec(text)[1]);
  assert.equal(text.slice(startxref, startxref + 4), 'xref');
  const m = /xref\n0 (\d+)\n/.exec(text.slice(startxref));
  const count = Number(m[1]);
  assert.equal(count, 1 + 3 + 2 * 3);                          // 0번(예약) + 카탈로그/쪽목록/정보 + 쪽당 3개
  const rows = text.slice(startxref + m[0].length).split('\n').slice(0, count);
  rows.forEach((row, n) => assert.equal(row.length + 1, 20, `xref 줄 길이 ${n}`));
  for (let n = 1; n < count; n++) {
    const off = Number(rows[n].slice(0, 10));
    assert.equal(text.slice(off, off + `${n} 0 obj`.length), `${n} 0 obj`, `객체 ${n} 오프셋`);
  }

  // 이미지 스트림 길이가 선언값과 같다
  const re = /\/Length (\d+) >>\nstream\n/g;
  let hit; let images = 0;
  while ((hit = re.exec(text))) {
    const len = Number(hit[1]);
    const start = hit.index + hit[0].length;
    assert.equal(text.slice(start + len, start + len + 10), '\nendstream', '스트림 길이');
    if (len === JPEG.length) images++;
  }
  assert.equal(images, 2);
  assert.match(text, /\/Filter \/DCTDecode/);
});

test('PDF: 한글 제목은 UTF-16BE 16진수 문자열로 들어간다', () => {
  const pdf = buildPdf([{ jpeg: JPEG, width: 10, height: 10 }], { title: '슈미트' });
  assert.match(latin1(pdf), /\/Title <FEFFC288BBF8D2B8>/);   // 슈 미 트
});

test('PDF: 이미지는 A4 가로 안에서 비율을 지키며 가운데에 놓인다', () => {
  const pdf = latin1(buildPdf([{ jpeg: JPEG, width: 2349, height: 1620 }]));
  const [, w, h, x, y] = /q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm \/Im0 Do Q/.exec(pdf).map(Number);
  assert.ok(Math.abs(w / h - 2349 / 1620) < 0.001, '비율 유지');
  assert.ok(x >= 22 && x + w <= 841.89 - 22 + 0.01, '좌우 여백 안');
  assert.ok(y >= 22 && y + h <= 595.28 - 22 + 0.01, '상하 여백 안');
});

test('PDF: 쪽이 없으면 오류', () => {
  assert.throws(() => buildPdf([]), /쪽/);
});

test('PDF: 쪽마다 용지 크기/여백을 따로 줄 수 있다 (가로 2쪽 + 세로 1쪽)', () => {
  const pdf = latin1(buildPdf([
    { jpeg: JPEG, width: 2349, height: 1621 },
    { jpeg: JPEG, width: 1588, height: 2246, pageWidth: 595.28, pageHeight: 841.89, margin: 0 },
  ]));
  const boxes = [...pdf.matchAll(/\/MediaBox \[0 0 ([\d.]+) ([\d.]+)\]/g)].map((m) => [Number(m[1]), Number(m[2])]);
  assert.deepEqual(boxes, [[841.89, 595.28], [595.28, 841.89]]);
  const ims = [...pdf.matchAll(/q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm \/Im0 Do Q/g)].map((m) => m.slice(1).map(Number));
  assert.ok(ims[0][0] <= 841.89 - 2 * 22.68 + 0.01, '가로 쪽은 기본 여백 8mm');
  const [w, h, x, y] = ims[1];                                    // 세로 쪽은 여백 0 → 용지에 꽉 찬다 (비율은 794:1123 이 A4 와 같아 거의 정확히)
  assert.ok(w > 594 && h > 840 && x < 1 && y < 1, `${w} x ${h} @ ${x},${y}`);
  assert.match(pdf, /\/Count 2/);
});