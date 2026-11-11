// 실행: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { excludeOutliers, angleCorrection, ageFactor, daysBetween, calculate } from '../js/calc.js';

const SAMPLE = [46, 49, 50, 49, 51, 48, 48, 49, 49, 48, 51, 48, 50, 48, 45, 52, 48, 47, 48, 51]; // 결과기록지.jpg
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≈ ${b}`);

test('이상값 제외: 샘플은 제외값 없음, 평균 48.75', () => {
  const r = excludeOutliers(SAMPLE);
  assert.equal(r.excluded, 0);
  near(r.meanKept, 48.75);
  assert.equal(r.retest, false);
});

test('이상값 제외: ±20% 밖의 값만 제외하고 나머지로 평균', () => {
  const v = [...SAMPLE]; v[0] = 20; v[1] = 70; // 평균≈48.7 → 허용 38.96~58.44
  const r = excludeOutliers(v);
  assert.deepEqual(r.flags.map((f, i) => (f ? i : -1)).filter((i) => i >= 0), [0, 1]);
  assert.equal(r.excluded, 2);
  assert.equal(r.kept.length, 18);
  assert.equal(r.retest, false);
});

test('이상값이 4개 이상이면 재시험', () => {
  const v = [...SAMPLE]; v[0] = 10; v[1] = 12; v[2] = 80; v[3] = 85;
  const r = excludeOutliers(v);
  assert.ok(r.excluded >= 4);
  assert.equal(r.retest, true);
});

test('경계값(정확히 ±20%)은 제외하지 않는다', () => {
  const v = [50, 50, 50, 50, 40, 60, 50, 50, 50, 50]; // 평균 50 → 40, 60 은 경계
  assert.equal(excludeOutliers(v).excluded, 0);
});

test('타격방향 보정: 0°는 보정 없음', () => {
  assert.equal(angleCorrection(48.8, 0).delta, 0);
});

test('타격방향 보정: 표의 격자점', () => {
  near(angleCorrection(50, 90).delta, -3.1);
  near(angleCorrection(30, -90).delta, 3.1);
  near(angleCorrection(40, -45).delta, 2.0);
  near(angleCorrection(20, 45).delta, -3.5);
});

test('타격방향 보정: R 구간 보간 / 범위 밖은 끝값', () => {
  near(angleCorrection(35, 90).delta, -4.3);   // 30(-4.7) ~ 40(-3.9) 중간
  near(angleCorrection(70, 90).delta, -2.3);   // 60 초과 → 60 값
  near(angleCorrection(5, -90).delta, 3.2);    // 10 미만 → 10 값
});

test("타격방향 보정: 표의 '-' 칸(R=10, +90/+45)은 R=20 값으로 대체하고 알린다", () => {
  const r = angleCorrection(10, 90);
  near(r.delta, -5.4);
  assert.ok(r.notes.length > 0);
});

test('타격방향 보정: 표에 없는 각도는 근사 보간하고 알린다', () => {
  const r = angleCorrection(50, 30);          // 0 ~ +45(-2.1) 사이
  near(r.delta, (-2.1 * 30) / 45);
  assert.ok(r.notes.some((n) => n.includes('근사')));
  near(angleCorrection(40, -60).delta, 2.0 + ((2.7 - 2.0) * 15) / 45);
});

test('재령계수: 표의 값 / 보간 / 범위 밖', () => {
  near(ageFactor(28).alpha, 1.0);
  near(ageFactor(4).alpha, 1.9);
  near(ageFactor(7).alpha, 1.72);
  const i = ageFactor(31);                      // 30(0.99) ~ 32(0.98)
  near(i.alpha, 0.985);
  assert.equal(i.interpolated, true);
  assert.equal(ageFactor(3).alpha, null);       // 4일 미만
  near(ageFactor(5000).alpha, 0.63);            // 3000일 초과
  near(ageFactor(110).alpha, 0.78 + ((0.76 - 0.78) * 10) / 25);
});

test('일수 계산 (시험일 - 타설일)', () => {
  assert.equal(daysBetween('2026-10-13', '2026-11-10'), 28);
  assert.equal(daysBetween('2026-02-28', '2026-03-01'), 1);
  assert.equal(daysBetween('', '2026-11-10'), null);
  assert.equal(daysBetween('2026-11-10', '2026-11-01'), -9);
});

test('전체 계산: 샘플 기록지 (R0=48.8, 0°, 28일 → Fc≈44.7MPa)', () => {
  const r = calculate({ values: SAMPLE, angle: 0, ageDays: 28 });
  near(r.R0, 48.8);
  near(r.A, (7.3 * 48.8 + 100) * 0.098);
  near(r.alpha, 1.0);
  near(r.Fc, 44.71152, 1e-4);
  assert.equal(r.warnings.length, 0);
});

test('전체 계산: 각도 보정 + 재령 보정 (R0 = 평균 + ΔR)', () => {
  const r = calculate({ values: SAMPLE, angle: -90, ageDays: 14 });  // 평균 48.75, R≈48.75 → ΔR(-90)
  const delta = angleCorrection(48.75, -90).delta;
  near(r.R0, Math.round((48.75 + delta) * 10) / 10);
  near(r.alpha, 1.36);
  near(r.Fc, (7.3 * r.R0 + 100) * 0.098 * 1.36, 1e-9);
});

test('전체 계산: 재시험 대상이면 Fc 없음', () => {
  const v = [...SAMPLE]; v[0] = 10; v[1] = 12; v[2] = 80; v[3] = 85;
  const r = calculate({ values: v, angle: 0, ageDays: 28 });
  assert.equal(r.retest, true);
  assert.equal(r.Fc, null);
});

test('전체 계산: 재령계수 직접 입력이 표 조회보다 우선', () => {
  const r = calculate({ values: SAMPLE, angle: 0, ageDays: 28, alphaOverride: 1.2 });
  near(r.alpha, 1.2);
});

test('전체 계산: 재령 미입력이면 Fc 없음(경고)', () => {
  const r = calculate({ values: SAMPLE, angle: 0, ageDays: null });
  assert.equal(r.Fc, null);
  assert.ok(r.R0 !== null);
});
