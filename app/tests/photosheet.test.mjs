// 실행: node --test tests/
// 사진대지 배치(js/photosheet.js)가 슈미트/사진대지.xlsx 의 열 너비·행 높이와 맞는지, 사진 맞춤 계산이 맞는지 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';

// photosheet.js 는 DOM 을 쓰는 함수가 있지만 가져오는 것만으로는 DOM 이 필요 없다
const { PHOTO_PAGE, photoRect, photoInset, blockTop, fitRect, photoTexts } = await import('../js/photosheet.js');
const PX = 4 / 3;

test('사진 칸 크기 = 엑셀의 B~H열 × 11행 (351pt × 270.6pt)', () => {
  const r = photoRect(0);
  assert.ok(Math.abs(r.w - 351 * PX) < 0.01, `너비 ${r.w}`);
  assert.ok(Math.abs(r.h - 11 * 24.6 * PX) < 0.01, `높이 ${r.h}`);
  assert.ok(Math.abs(photoRect(1).w - r.w) < 1e-9);
});

test('두 번째 칸은 첫 칸 아래 13행(사진 11 + 표 2) 만큼 내려간다', () => {
  assert.ok(Math.abs(blockTop(1) - blockTop(0) - 13 * 24.6 * PX) < 0.01);
});

test('양식 전체가 A4 세로(794×1123) 안에 들어가고 가로 가운데에 놓인다', () => {
  const r0 = photoRect(0), r1 = photoRect(1);
  const left = r0.x - 75 * PX, right = r0.x + r0.w;
  assert.ok(Math.abs((left + right) / 2 - PHOTO_PAGE.w / 2) < 0.6, `가로 가운데 ${(left + right) / 2}`);
  assert.ok(left > 0 && right < PHOTO_PAGE.w);
  const bottomOfTable = blockTop(1) + 13 * 24.6 * PX;
  assert.ok(bottomOfTable + 2 * 16.8 * PX < PHOTO_PAGE.h - 28.35 * PX, `표 아래 ${bottomOfTable}`);   // 바닥 여백 안
  assert.ok(r1.y > r0.y + r0.h);
});

test('사진 맞춤: contain 은 전체가 보이고 cover 는 칸을 채운다', () => {
  const rect = { x: 100, y: 50, w: 400, h: 300 };
  const c = fitRect(1000, 1000, rect, 'contain');            // 정사각 사진 → 높이에 맞고 좌우가 남는다
  assert.deepEqual([c.w, c.h], [300, 300]);
  assert.deepEqual([c.x, c.y], [150, 50]);
  const v = fitRect(1000, 1000, rect, 'cover');              // 칸을 채우고 위아래가 넘친다
  assert.deepEqual([v.w, v.h], [400, 400]);
  assert.deepEqual([v.x, v.y], [100, 0]);
  const same = fitRect(800, 600, rect, 'contain');           // 4:3 사진은 4:3 칸에 딱 맞는다
  assert.deepEqual([same.x, same.y, same.w, same.h], [100, 50, 400, 300]);
});

test('사진대지 글: 시험 정보에서 가져오고 날짜는 "2026. 08. 03" 형식, 머리글·바닥글은 설정값', () => {
  const src = { site: '테스트 현장 A동', workName: '콘크리트 반발경도 확인', location: '208동 15층 벽체', pourDate: '2026-08-03', testDate: '2026-11-10' };
  assert.deepEqual(photoTexts(src), { site: '테스트 현장 A동', work: '콘크리트 반발경도 확인', location: '208동 15층 벽체', pour: '2026. 08. 03', test: '2026. 11. 10', head: '', foot: '' });
  const t = photoTexts(src, { head: '[ 머리글 ]', foot: '바닥글 문구' });
  assert.deepEqual([t.head, t.foot], ['[ 머리글 ]', '바닥글 문구']);
  assert.deepEqual(photoTexts({}), { site: '', work: '', location: '', pour: '', test: '', head: '', foot: '' });
});