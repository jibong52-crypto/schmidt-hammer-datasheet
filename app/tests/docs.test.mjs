// 실행: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { blankDoc, docFromState, stateFromDoc, calcFor, docSignature, hasContent, statusFlags, summaryOf, groupByDate, matches, safeName, fileBase, bundleName, toCsv, sanitizeDoc, weekdayKo, titleOf, subtitleOf, docFromRecord, normBoxes, denormBoxes, fitSize, PHOTO_MAX_SIDE, DEFAULT_WORK, MAX_SHOTS, photoPageCount, fmtDotDate } from '../js/docs.js';

const SAMPLE = [46, 49, 50, 49, 51, 48, 48, 49, 49, 48, 51, 48, 50, 48, 45, 52, 48, 47, 48, 51];
const mk = (over = {}) => blankDoc({ site: '테스트 현장 A동', location: '3층 기둥 C5', tester: '홍길동', supervisor: '김감리', testDate: '2026-11-10', pourDate: '2026-10-13', values: [...SAMPLE], printedAverage: 48.8, ...over });

test('문서 ↔ 상태 변환은 입력값을 그대로 보존한다', () => {
  const d = mk();
  const s = stateFromDoc(d);
  s.values[0] = 20;                                   // 상태를 고쳐도 문서는 안 바뀐다(복사본)
  assert.equal(d.values[0], 46);
  const back = docFromState(stateFromDoc(d), { id: d.id, createdAt: d.createdAt, updatedAt: d.updatedAt });
  assert.equal(docSignature(back), docSignature(d));
});

test('계산은 화면과 같은 규칙: 28일 → α 1.00, Fc 44.7MPa', () => {
  const calc = calcFor(stateFromDoc(mk()));
  assert.equal(calc.ageDays, 28);
  assert.equal(calc.alpha, 1);
  assert.equal(calc.R0, 48.8);
  assert.equal(Math.round(calc.Fc * 10) / 10, 44.7);
  const s = summaryOf(mk());
  assert.equal(s.flags.length, 0);
  assert.equal(Math.round(s.Fc * 10) / 10, 44.7);
});

test('저장 서명: 입력값이 바뀌면 달라지고 메타(updatedAt)만 바뀌면 같다', () => {
  const d = mk();
  assert.equal(docSignature(d), docSignature({ ...d, updatedAt: d.updatedAt + 1000 }));
  assert.notEqual(docSignature(d), docSignature({ ...d, site: '다른 현장' }));
  const v = [...d.values]; v[3] = 50;
  assert.notEqual(docSignature(d), docSignature({ ...d, values: v }));
});

test('문서로 남길 내용이 있는가', () => {
  assert.equal(hasContent({ values: Array(20).fill(null) }, false), false);
  assert.equal(hasContent({ values: Array(20).fill(null) }, true), true);
  assert.equal(hasContent({ values: [...SAMPLE] }, false), true);
});

test('판정 표시: 재시험 / 평균 불일치 / 개수 부족 / 타설일 필요 / 각도 미확정', () => {
  const retest = [...SAMPLE]; retest[0] = 10; retest[1] = 12; retest[2] = 80; retest[3] = 85;
  assert.deepEqual(statusFlags(mk({ values: retest, printedAverage: null })).map((f) => f.text), ['재시험']);
  assert.ok(statusFlags(mk({ printedAverage: 47.0 })).some((f) => f.text === '평균 불일치'));
  assert.ok(statusFlags(mk({ values: [...SAMPLE.slice(0, 15), ...Array(5).fill(null)], printedAverage: null })).some((f) => f.text === '15/20개'));
  assert.ok(statusFlags(mk({ pourDate: '' })).some((f) => f.text === '타설일 필요'));
  assert.ok(statusFlags(mk({ angle: null })).some((f) => f.text === '각도 미확정'));
  assert.ok(statusFlags(mk({ values: Array(20).fill(null), printedAverage: null })).some((f) => f.text === '측정값 없음'));
});

test('시험일별 묶음: 날짜는 최근순, 같은 날은 만든 순서, 날짜 없는 문서는 맨 뒤', () => {
  const a = mk({ id: 'a', testDate: '2026-11-09', createdAt: 100 });
  const b = mk({ id: 'b', testDate: '2026-11-10', createdAt: 300 });
  const c = mk({ id: 'c', testDate: '2026-11-10', createdAt: 200 });
  const z = mk({ id: 'z', testDate: '', createdAt: 50 });
  const g = groupByDate([a, b, z, c]);
  assert.deepEqual(g.map((x) => x.date), ['2026-11-10', '2026-11-09', '']);
  assert.deepEqual(g[0].docs.map((d) => d.id), ['c', 'b']);
});

test('검색: 현장명·시험위치·시험자·감리원·날짜, 대소문자 무시', () => {
  const d = mk({ site: 'ABC Tower' });
  assert.ok(matches(d, 'abc'));
  assert.ok(matches(d, '기둥'));
  assert.ok(matches(d, '홍길'));
  assert.ok(matches(d, '김감'));
  assert.ok(matches(d, '2026-11'));
  assert.ok(matches(d, ''));
  assert.ok(!matches(d, '없는말'));
});

test('파일 이름 정리: 금지 문자 제거, 길이 제한, 순번', () => {
  assert.equal(safeName('A/B:C*D?"E<F>G|H\\I'), 'A_B_C_D__E_F_G_H_I');
  assert.equal(safeName('  .점으로 시작.  '), '점으로 시작');
  assert.equal(safeName('가'.repeat(100), 10).length, 10);
  assert.equal(fileBase(mk(), 0), '01_테스트 현장 A동_3층 기둥 C5');
  assert.equal(fileBase(mk({ site: '', location: '' }), 11), '12_문서');
  assert.equal(bundleName([mk()]), '슈미트해머_2026-11-10_1건.zip');
  assert.equal(bundleName([mk(), mk({ testDate: '2026-11-08' })]), '슈미트해머_2026-11-08~2026-11-10_2건.zip');
});

test('CSV: BOM, CRLF, 따옴표 처리, 계산 결과 열', () => {
  const items = [
    { doc: mk(), file: '2026-11-10/01_테스트 현장 A동_3층 기둥 C5.pdf' },
    { doc: mk({ id: 'x', site: '따옴표 "현장", 쉼표', createdAt: 5 }), file: '' },
  ];
  const csv = toCsv(items);
  assert.ok(csv.startsWith('\uFEFF시험일,번호,현장명'));
  const lines = csv.trimEnd().split('\r\n');
  assert.equal(lines.length, 3);
  assert.match(lines[1], /^2026-11-10,1,테스트 현장 A동,3층 기둥 C5,홍길동,김감리,2026-10-13,28,1\.00,20,48\.75,0,0,48\.8,44\.7,정상,/);
  assert.match(lines[2], /"따옴표 ""현장"", 쉼표"/);
  assert.match(lines[2], /^2026-11-10,2,/);                  // 같은 날 두 번째
});

test('가져오기 검증: 모양이 틀린 값은 바로잡고, 쓸 수 없는 문서는 버린다', () => {
  assert.equal(sanitizeDoc(null), null);
  assert.equal(sanitizeDoc({ values: [] }), null);              // id 없음
  const raw = { id: 'q1', createdAt: 5, updatedAt: 9, testDate: '2026/11/10', site: 7, values: ['x', 50, null, 'NaN'], angle: 45, order: 'zzz', photo: { rotation: 33, boxes: { 1: [0, 0, 1, 1], 99: [0, 0, 1, 1], 2: ['a'] }, width: 100, height: 200 } };
  const d = sanitizeDoc(raw);
  assert.equal(d.id, 'q1');
  assert.equal(d.testDate, '');                                  // 형식이 다른 날짜는 비움
  assert.equal(d.site, '');
  assert.equal(d.values.length, 20);
  assert.equal(d.values[1], 50);
  assert.equal(d.values[0], null);
  assert.equal(d.angle, 45);
  assert.equal(d.order, 'row');
  assert.deepEqual(Object.keys(d.photo.boxes), ['1']);
  assert.equal(d.photo.rotation, 0);
});

test('표시용 보조 함수', () => {
  assert.equal(weekdayKo('2026-11-10'), '화');
  assert.equal(weekdayKo(''), '');
  assert.equal(titleOf(mk({ site: '' })), '(현장명 없음)');
  assert.equal(subtitleOf(mk()), '3층 기둥 C5 · 홍길동');
  assert.equal(subtitleOf(mk({ location: '', tester: '' })), '시험위치·시험자 미입력');
});

test('사진 크기: 긴 변 2800px 로 줄이고 이미 작으면 그대로', () => {
  assert.deepEqual(fitSize(4000, 3000), { width: 2800, height: 2100 });
  assert.deepEqual(fitSize(1000, 700), { width: 1000, height: 700 });
  assert.deepEqual(fitSize(3000, 4000), { width: 2100, height: 2800 });
  assert.equal(PHOTO_MAX_SIDE, 2800);
});

test('행 박스 정규화/복원: 4자리로 맞추고, 왕복해도 값이 변하지 않는다', () => {
  const boxes = { 1: { x0: 100, y0: 200, x1: 900.5, y1: 260 }, 20: { x0: 10, y0: 3000, x1: 20, y1: 3100 } };
  const n = normBoxes(boxes, 1000, 4000);
  assert.deepEqual(n[1], [0.1, 0.05, 0.9005, 0.065]);
  // 저장 → 열기 → 다시 정규화해도 같다 → 문서를 열기만 해서 "변경됨"으로 보이지 않는다
  assert.deepEqual(normBoxes(denormBoxes(n, 1000, 4000), 1000, 4000), n);
  assert.deepEqual(normBoxes(denormBoxes(n, 2800, 1400), 2800, 1400), n);
});

test('OCR 결과로 문서 만들기: 회전된 크기 기준 정규화, 저장용 사진 크기, 평균/각도', () => {
  const rec = {
    rotation: 90, angle: -45, average: { value: 48.8 },
    rows: [
      { n: 1, value: 46, review: false, box: { x0: 0, y0: 0, x1: 2000, y1: 100 } },
      { n: 2, value: 49, review: true, box: { x0: 0, y0: 100, x1: 2000, y1: 200 } },
      { n: 21, value: 99, review: false, box: { x0: 0, y0: 0, x1: 1, y1: 1 } },     // 20번을 넘는 행은 버린다
    ],
  };
  const doc = docFromRecord(rec, { width: 4000, height: 2000 }, { testDate: '2026-11-10', site: '현장 A' });
  assert.equal(doc.testDate, '2026-11-10');
  assert.equal(doc.site, '현장 A');
  assert.equal(doc.values.filter(Number.isFinite).length, 2);
  assert.deepEqual([doc.values[0], doc.values[1], doc.review[1]], [46, 49, true]);
  assert.equal(doc.printedAverage, 48.8);
  assert.equal(doc.angle, -45);
  // 90° 회전 → 회전된 크기는 2000 x 4000, 저장하는 사진은 긴 변 2800px 로 줄어 2800 x 1400
  assert.deepEqual(doc.photo, { rotation: 90, width: 2800, height: 1400, boxes: { 1: [0, 0, 1, 0.025], 2: [0, 0.025, 1, 0.05] } });
  assert.equal(docFromRecord({ ...rec, average: null, angle: null }, { width: 100, height: 50 }).printedAverage, null);
  assert.equal(docFromRecord({ ...rec, average: null, angle: null }, { width: 100, height: 50 }).angle, null);
});
test('사진대지: 기본값, 쪽 수(2장당 1쪽), 날짜 표기', () => {
  const d = blankDoc();
  assert.deepEqual([d.shots, d.workName, d.shotFit], [[], DEFAULT_WORK, 'contain']);
  assert.equal(DEFAULT_WORK, '콘크리트 반발경도 확인');
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(photoPageCount), [0, 1, 1, 2, 2, 3]);
  assert.equal(fmtDotDate('2026-08-03'), '2026. 08. 03');
  assert.equal(fmtDotDate(''), '');
});

test('사진대지: 문서 ↔ 상태 왕복, 저장 서명에 사진 목록·시험내용·배치가 들어간다', () => {
  const shots = [{ id: 'a1', width: 1600, height: 1200 }, { id: 'b2', width: 900, height: 1600 }];
  const d = mk({ shots, workName: '반발경도 시험 전경', shotFit: 'cover' });
  const s = stateFromDoc(d);
  s.shots[0].width = 1;                                         // 상태를 고쳐도 문서는 안 바뀐다(복사본)
  assert.equal(d.shots[0].width, 1600);
  const back = docFromState(stateFromDoc(d), { id: d.id, createdAt: d.createdAt, updatedAt: d.updatedAt });
  assert.equal(docSignature(back), docSignature(d));
  assert.notEqual(docSignature(d), docSignature({ ...d, shots: [shots[1], shots[0]] }));       // 순서가 바뀌면 달라진다
  assert.notEqual(docSignature(d), docSignature({ ...d, shotFit: 'contain' }));
  assert.notEqual(docSignature(d), docSignature({ ...d, workName: '' }));
  // 예전 문서(사진대지 필드 없음)도 열린다
  const old = { ...d }; delete old.shots; delete old.workName; delete old.shotFit;
  assert.deepEqual([stateFromDoc(old).shots, stateFromDoc(old).workName, stateFromDoc(old).shotFit], [[], DEFAULT_WORK, 'contain']);
});

test('사진대지: 사진만 있어도 문서로 남긴다', () => {
  assert.equal(hasContent({ values: Array(20).fill(null), shots: [] }, false), false);
  assert.equal(hasContent({ values: Array(20).fill(null), shots: [{ id: 'x' }] }, false), true);
});

test('사진대지: 가져온 문서의 사진 목록을 검증한다', () => {
  const raw = { id: 'q9', values: [], shots: [{ id: 'ok-1_a', width: 10, height: 20 }, { id: '../evil', width: 1, height: 1 }, { id: '', width: 1, height: 1 }, null, { id: 'x'.repeat(41) }, { id: 'ok2', width: 'abc' }], workName: 7, shotFit: 'zoom' };
  const d = sanitizeDoc(raw);
  assert.deepEqual(d.shots, [{ id: 'ok-1_a', width: 10, height: 20 }, { id: 'ok2', width: 0, height: 0 }]);   // 경로처럼 생긴 id 는 버린다
  assert.equal(d.workName, DEFAULT_WORK);
  assert.equal(d.shotFit, 'contain');
  const many = sanitizeDoc({ id: 'm', shots: Array.from({ length: 80 }, (_, i) => ({ id: `s${i}`, width: 1, height: 1 })) });
  assert.equal(many.shots.length, MAX_SHOTS);
});