// KS F 2730 반발경도 시험 계산 (양식의 안내문과 계산식을 그대로 구현)
//   ① 20개 평균에서 ±20%를 벗어난 값은 제외하고 평균을 다시 구한다.
//      벗어난 값이 4개 이상이면 전체 시험값을 버리고 재시험한다.
//   ② 타격방향(ANGLE)에 의한 보정값을 반발경도에 더한다.
//   ③ Fc = (7.3·R0 + 100) × 0.098 [MPa] 에 재령계수(α)를 곱한다.
import { AGE_TABLE, ANGLE_TABLE, ANGLE_COLUMNS } from './tables.js';

export const OUTLIER_RATE = 0.2;      // ±20%
export const RETEST_COUNT = 4;        // 제외값이 이 개수 이상이면 재시험
export const KGF_TO_MPA = 0.098;

const round1 = (x) => Math.round(x * 10) / 10;
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

/** 두 점 (x0,y0)-(x1,y1) 사이 선형 보간 */
function lerp(x, x0, y0, x1, y1) {
  return x1 === x0 ? y0 : y0 + ((y1 - y0) * (x - x0)) / (x1 - x0);
}

/** ① 이상값 제외 */
export function excludeOutliers(values) {
  const valid = values.filter((v) => Number.isFinite(v));
  if (!valid.length) return { meanAll: null, lower: null, upper: null, flags: values.map(() => false), excluded: 0, kept: [], meanKept: null, retest: false };
  const meanAll = mean(valid);
  const lower = meanAll * (1 - OUTLIER_RATE);
  const upper = meanAll * (1 + OUTLIER_RATE);
  // 허용범위(경계 포함) 밖의 값만 제외
  const flags = values.map((v) => Number.isFinite(v) && (v < lower - 1e-9 || v > upper + 1e-9));
  const kept = valid.filter((v) => v >= lower - 1e-9 && v <= upper + 1e-9);
  const excluded = flags.filter(Boolean).length;
  return { meanAll, lower, upper, flags, excluded, kept, meanKept: kept.length ? mean(kept) : null, retest: excluded >= RETEST_COUNT };
}

/**
 * ② 타격방향 보정값 ΔR (표: +90/+45/-45/-90, R=10~60)
 *  - R 방향: 표 구간 선형보간, 범위 밖은 양 끝값 사용
 *  - 각도 방향: 표에 없는 각도는 0°(보정 0)와 표 열 사이를 선형보간 (근사)
 *  - 표의 '-' (+90/+45 에서 R=10) 는 값이 없으므로 R=20 값을 사용
 */
export function angleCorrection(R, angle) {
  const notes = [];
  if (!Number.isFinite(angle) || angle === 0) return { delta: 0, notes };

  const rows = ANGLE_TABLE;
  const colValue = (colIdx) => {
    // colIdx: 1..4 (ANGLE_COLUMNS 인덱스 + 1). R로 보간한 보정값
    const pts = rows.map((r) => [r[0], r[colIdx]]);
    let usable = pts.filter((p) => p[1] !== null);
    if (usable.length < pts.length && R < usable[0][0]) notes.push(`표에 R=${pts[0][0]} 값이 없어 R=${usable[0][0]} 값을 사용`);
    if (R <= usable[0][0]) return usable[0][1];
    if (R >= usable[usable.length - 1][0]) return usable[usable.length - 1][1];
    for (let i = 1; i < usable.length; i++) {
      if (R <= usable[i][0]) return lerp(R, usable[i - 1][0], usable[i - 1][1], usable[i][0], usable[i][1]);
    }
    return 0;
  };

  const idx = ANGLE_COLUMNS.indexOf(angle);
  if (idx >= 0) return { delta: colValue(idx + 1), notes };

  // 표에 없는 각도 (예: ±15, ±30, ±60): 이웃 열 사이를 선형보간
  const sign = angle > 0 ? 1 : -1;
  const a = Math.abs(angle);
  const upper = a <= 45 ? 45 : 90;
  const lowerAngle = a <= 45 ? 0 : 45;
  const vHigh = colValue(ANGLE_COLUMNS.indexOf(sign * upper) + 1);
  const vLow = lowerAngle === 0 ? 0 : colValue(ANGLE_COLUMNS.indexOf(sign * lowerAngle) + 1);
  notes.push(`${angle}°는 보정표에 없어 인접 각도 사이를 선형보간한 근사값입니다`);
  return { delta: lerp(a, lowerAngle, vLow, upper, vHigh), notes };
}

/** ③ 재령계수(α): 표에 없는 재령일은 이웃 값 사이를 선형보간 */
export function ageFactor(days) {
  if (!Number.isFinite(days)) return { alpha: null, note: '재령일을 알 수 없습니다', interpolated: false };
  const first = AGE_TABLE[0], last = AGE_TABLE[AGE_TABLE.length - 1];
  if (days < first[0]) return { alpha: null, note: `재령 ${first[0]}일 미만은 표에 없습니다`, interpolated: false };
  if (days >= last[0]) return { alpha: last[1], note: days > last[0] ? `재령 ${last[0]}일 초과: ${last[0]}일 값 사용` : '', interpolated: false };
  for (let i = 0; i < AGE_TABLE.length; i++) {
    const [d, a] = AGE_TABLE[i];
    if (days === d) return { alpha: a, note: '', interpolated: false };
    if (days < d) {
      const [d0, a0] = AGE_TABLE[i - 1];
      return { alpha: Math.round(lerp(days, d0, a0, d, a) * 1000) / 1000, note: `${d0}일(${a0})과 ${d}일(${a}) 사이 선형보간`, interpolated: true };
    }
  }
  return { alpha: last[1], note: '', interpolated: false };
}

/** 두 날짜(YYYY-MM-DD) 사이의 일수 = 시험일 - 타설일 */
export function daysBetween(pour, test) {
  if (!pour || !test) return null;
  const a = Date.UTC(...pour.split('-').map((n, i) => (i === 1 ? +n - 1 : +n)));
  const b = Date.UTC(...test.split('-').map((n, i) => (i === 1 ? +n - 1 : +n)));
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * 전체 계산.
 * @param {object} s
 * @param {(number|null)[]} s.values   R 측정값 (순서대로, 빈 값은 null)
 * @param {number|null} s.angle        타격 각도 (°)
 * @param {number|null} s.ageDays      재령일
 * @param {number|null} [s.alphaOverride]  재령계수 직접 지정
 */
export function calculate({ values, angle, ageDays, alphaOverride }) {
  const warnings = [];
  const out = excludeOutliers(values);
  const filled = values.filter((v) => Number.isFinite(v)).length;
  const res = {
    ...out, filled, angle, ageDays,
    angleDelta: null, R0: null, A: null, alpha: null, alphaNote: '', alphaInterpolated: false, Fc: null, warnings,
  };
  if (!filled) { warnings.push('측정값이 없습니다.'); return res; }
  if (filled < 20) warnings.push(`측정값이 ${filled}개입니다 (기준 20개).`);
  if (out.retest) {
    warnings.push(`평균 ±20%를 벗어난 시험값이 ${out.excluded}개(≥${RETEST_COUNT})입니다. 전체 시험값을 버리고 재시험해야 합니다.`);
  } else if (out.excluded) {
    warnings.push(`평균 ±20%를 벗어난 값 ${out.excluded}개를 제외하고 평균을 다시 구했습니다.`);
  }

  const corr = angleCorrection(out.meanKept ?? out.meanAll, angle ?? 0);
  res.angleDelta = corr.delta;
  warnings.push(...corr.notes);

  // 양식에 적히는 R0는 소수 첫째 자리까지 (기록지 AVERAGE와 같은 자릿수)
  if (out.meanKept !== null) res.R0 = round1(out.meanKept + corr.delta);

  res.alphaOverrideUsed = alphaOverride != null && Number.isFinite(alphaOverride);
  if (res.alphaOverrideUsed) {
    res.alpha = alphaOverride; res.alphaNote = '직접 입력한 값';
  } else {
    const af = ageFactor(ageDays);
    res.alpha = af.alpha; res.alphaNote = af.note; res.alphaInterpolated = af.interpolated;
    if (af.alpha === null) warnings.push(af.note);
    else if (af.note && !af.interpolated) warnings.push(af.note);
  }

  if (res.R0 !== null) {
    res.A = (7.3 * res.R0 + 100) * KGF_TO_MPA;
    if (res.alpha !== null && !out.retest) res.Fc = res.A * res.alpha;
  }
  return res;
}
