// OCR 줄 → 기록지 구조화 (파서) 테스트. 픽스처는 실제 샘플 결과기록지에서 엔진이 내놓은 형태를 그대로 옮긴 것.
// 실행: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecord, parseAngleText, isAngleText } from '../js/ocr/record.js';

/** 엔진이 돌려주는 줄 모양: { text, conf, chars:[{c,p}], box, rowPos } */
const line = (text, y, conf = 0.95) => ({
  text, conf, chars: [...text].map((c) => ({ c, p: conf })),
  box: { x0: 100, y0: y, x1: 650, y1: y + 90 }, rowPos: y + 45,
});

const VALUES = [46, 49, 50, 49, 51, 48, 48, 49, 49, 48, 51, 48, 50, 48, 45, 52, 48, 47, 48, 51];
const cleanLines = () => [
  line('R UALUE', 80),
  ...VALUES.map((v, i) => line(`R ${String(i + 1).padStart(2, '0')} ${v}`, 190 + i * 115)),
  line('AUERAGE 48.8', 2600),
  line('ANGLE O', 2720),
];

test('깨끗한 기록지: 20행, 평균 일치, ANGLE 0, 기록지로 판정', () => {
  const r = parseRecord(cleanLines());
  assert.deepEqual(r.rows.map((x) => x.value), VALUES);
  assert.deepEqual(r.rows.map((x) => x.n), VALUES.map((_, i) => i + 1));
  assert.equal(r.average.value, 48.8);
  assert.equal(r.avgMatch, true);
  assert.equal(r.angle, 0);
  assert.equal(r.seqOk, true);
  assert.equal(r.valid, true);
});

test('OCR 잡음이 붙은 행: 막대그래프/가장자리 글자가 뒤에 붙어도 값은 앞의 두 숫자', () => {
  const ls = cleanLines();
  ls[7] = line('R 07 48 SHN', 190 + 6 * 115);          // R07
  ls[14] = line('R14 48 S', 190 + 13 * 115);           // 번호가 R에 붙음
  ls[20] = line('R 20 51 WHWNNITEN', 190 + 19 * 115);
  ls[1] = line('R 01 46 .', 190);
  const r = parseRecord(ls);
  assert.deepEqual(r.rows.map((x) => x.value), VALUES);
});

test('값 뒤에 구두점이 붙은 행("R 16 52:")도 값으로 읽는다 (사파리 엔진에서 나온 모양)', () => {
  const ls = cleanLines();
  ls[16] = line('R 16 52:', 190 + 15 * 115);
  const r = parseRecord(ls);
  assert.deepEqual(r.rows.map((x) => x.value), VALUES);
  assert.equal(r.avgMatch, true);
});

test('공백이 사라져 숫자가 붙은 행("R0146", "R09497")', () => {
  const ls = cleanLines();
  ls[1] = line('R0146', 190);
  ls[9] = line('R09497', 190 + 8 * 115);               // 값 뒤에 잡음 숫자
  const r = parseRecord(ls);
  assert.equal(r.rows[0].value, 46);
  assert.equal(r.rows[8].value, 49);
  assert.ok(r.rows[0].review && r.rows[8].review, '붙어서 읽힌 행은 검토 표시');
});

test('슬래시 0이 O/D 로 읽혀도 번호·값을 복원', () => {
  const ls = cleanLines();
  ls[5] = line('R O5 51', 190 + 4 * 115);              // 05
  ls[10] = line('R 1O 48', 190 + 9 * 115);             // 10
  const r = parseRecord(ls);
  assert.deepEqual(r.rows.map((x) => x.n), VALUES.map((_, i) => i + 1));
  assert.equal(r.rows[9].value, 48);
});

test('번호를 잘못 읽어도(84≈04) 순서로 보정', () => {
  const ls = cleanLines();
  ls[4] = line('R 84 49', 190 + 3 * 115);              // 04 를 84 로
  const r = parseRecord(ls);
  assert.equal(r.rows[3].n, 4);
  assert.equal(r.rows[3].value, 49);
  assert.equal(r.seqOk, true);
});

test('행 하나가 검출되지 않으면 번호 빈칸으로 남기고 경고', () => {
  const ls = cleanLines().filter((l) => !/R 03 /.test(l.text));
  const r = parseRecord(ls);
  assert.equal(r.count, 19);
  assert.equal(r.seqOk, false);
  assert.ok(!r.rows.some((x) => x.n === 3));
  assert.equal(r.rows.find((x) => x.n === 4).value, 49);   // 뒤 행은 번호대로 제자리
  assert.ok(r.warnings.some((w) => w.includes('연속')));
});

test('AVERAGE 파싱: 소수점 누락/정수/키워드 오독', () => {
  const avg = (t) => parseRecord([...cleanLines().slice(0, 21), line(t, 2600)]).average?.value;
  assert.equal(avg('AUERAGE 48.8'), 48.8);
  assert.equal(avg('AVERAGE 48.8'), 48.8);
  assert.equal(avg('AUERAGE 488'), 48.8);     // 점이 빠짐
  assert.equal(avg('AUERAGE 48'), 48);
});

test('평균 일치 판정은 기록지의 반올림(±0.05) 기준', () => {
  const mk = (avgText) => parseRecord([...cleanLines().slice(0, 21), line(avgText, 2600)]);
  assert.equal(mk('AVERAGE 48.8').avgMatch, true);    // 실제 48.75 → 48.8
  assert.equal(mk('AVERAGE 48.7').avgMatch, true);    // 48.75 → 48.7 로 내림해도 ±0.05
  assert.equal(mk('AVERAGE 48.6').avgMatch, false);
  assert.equal(mk('AVERAGE 49.0').avgMatch, false);
});

test('ANGLE 텍스트 해석', () => {
  assert.equal(parseAngleText('ANGLE O')?.value, 0);
  assert.equal(parseAngleText('ANGLEO')?.value, 0);     // 붙어서 읽힘
  assert.equal(parseAngleText('ANGLE 0')?.value, 0);
  assert.equal(parseAngleText('ANGLE D')?.value, 0);
  assert.equal(parseAngleText('ANGLE 90')?.value, 90);
  assert.equal(parseAngleText('ANGLE -90')?.value, -90);
  assert.equal(parseAngleText('ANGLE -45')?.value, -45);
  assert.equal(parseAngleText('ANGLE 45')?.value, 45);
});

test('ANGLE: 외딴 글리프 오독(9, 5, G)은 유효 각도가 아니므로 거부', () => {
  for (const t of ['ANGLE 9', 'ANGLE 5', 'ANGLE G', 'ANGLE', 'ANGLE 7']) assert.equal(parseAngleText(t), null, t);
});

test('ANGLE 줄: 신뢰도 낮은 값은 채택하지 않고 박스를 남겨 재판독하게 한다', () => {
  const ls = cleanLines();
  ls[ls.length - 1] = { ...line('ANGLE O', 2720, 0.4), parts: [] };
  const r = parseRecord(ls);
  assert.equal(r.angle, null);
  assert.ok(r.angleBox, 'angleBox 가 있어야 reader 가 다시 읽는다');
  assert.ok(isAngleText('ANGLE 9') && isAngleText('ANGLEO') && !isAngleText('R 01 46'));
});

test('검토 표시: 평균이 일치하면 낮은 신뢰도(0.4)는 넘어가고, 불일치하면 표시', () => {
  const lowConfRow = (ls) => { ls[3] = line('R 03 50', 190 + 2 * 115, 0.4); return ls; };   // 3번 행만 신뢰도 낮음
  const ok = parseRecord(lowConfRow(cleanLines()));
  assert.equal(ok.avgMatch, true);
  assert.equal(ok.rows[2].review, false);

  const bad = cleanLines();
  bad[bad.length - 2] = line('AUERAGE 47.0', 2600);   // 일치하지 않는 평균
  const r = parseRecord(lowConfRow(bad));
  assert.equal(r.avgMatch, false);
  assert.equal(r.rows[2].review, true);
  // 값이 비정상 범위거나 붙어서 읽힌 행은 평균이 맞아도 표시
  const odd = cleanLines();
  odd[1] = line('R0146', 190);
  assert.equal(parseRecord(odd).rows[0].review, true);
});

test('기록지가 아닌 숫자 이미지(그래프 눈금, 재령표)는 기록지로 판정하지 않는다', () => {
  const chart = ['-8', '-7 100E 8 000001', '+60 +90', '-6 8', '-5 +45', '-4', '+30', '-3', '-2 -+15', 'R=10 20 30 40 50'].map((t, i) => line(t, 100 + i * 100));
  assert.equal(parseRecord(chart).valid, false);
  // 재령보정계수표처럼 번호(재령일)가 4부터 올라가는 표
  const table = Array.from({ length: 12 }, (_, i) => line(`${i + 4} 1.${90 - i * 6}`, 100 + i * 60));
  assert.equal(parseRecord(table).valid, false);
});

test('AVERAGE 줄이 없어도 번호가 1부터 잘 이어지면 기록지로 판정', () => {
  const r = parseRecord(cleanLines().filter((l) => !/AUERAGE|ANGLE/.test(l.text)));
  assert.equal(r.average, null);
  assert.equal(r.valid, true);
  assert.equal(r.avgMatch, null);
});

test('기울어진 사진: 줄의 표시 순서가 아니라 rowPos 로 정렬', () => {
  const ls = cleanLines();
  // 기울기 때문에 box 중심 y 와 rowPos 의 순서가 엇갈리는 상황을 흉내: 일부 행의 box.y 를 뒤섞는다
  ls.slice(1, 21).forEach((l, i) => { l.box = { ...l.box, y0: (i % 2 ? -400 : 400) + l.box.y0, y1: (i % 2 ? -400 : 400) + l.box.y1 }; });
  const r = parseRecord(ls);
  assert.deepEqual(r.rows.map((x) => x.value), VALUES);
});
