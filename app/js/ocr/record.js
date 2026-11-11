// OCR 줄 목록 → 슈미트해머 결과기록지 구조화 + 검증.
// 입력 줄: engine.recognize()가 반환한 [{ text, conf, chars:[{c,p}], box }]
//
// 기록지 형식 (KAMEKURA 디지털 반발경도계 프린터):
//   R  VALUE
//   R 01   46 ▭▭▭
//   ...
//   AVERAGE 48.8
//   ANGLE     0

// 숫자 문맥에서 숫자로 잘못 읽히기 쉬운 글자 (슬래시 0 등)
const CONFUSE = { O: '0', D: '0', Q: '0', I: '1', L: '1', '|': '1', Z: '2', S: '5', G: '6', B: '8' };

/** 문자 단위 정보를 토큰(공백 구분)으로 쪼갠다 */
function tokenize(chars) {
  const tokens = [];
  let cur = null;
  for (const ch of chars) {
    if (ch.c === ' ' || ch.c === '') { cur = null; continue; }
    if (!cur) { cur = { text: '', ps: [] }; tokens.push(cur); }
    cur.text += ch.c;
    cur.ps.push(ch.p ?? 1);
  }
  return tokens.map((t) => ({ text: t.text, conf: Math.min(...t.ps) }));
}

/** 토큰을 숫자 문자열로 정규화. 진짜 숫자가 하나도 없으면 null (allowPure: 'O' 같은 단독 혼동문자 허용) */
function numericOf(token, allowPure = false) {
  // 줄 끝 구두점은 떼고("52:" → "52": 옆의 막대 그래프가 기호로 읽힌 것), "R14" → "14"
  let s = token.text.toUpperCase().replace(/[:;.,'`"!?)\]]+$/, '').replace(/^R(?=[0-9ODQILZSGB|])/, '');
  s = s.replace(/^[+]/, '');
  const neg = s.startsWith('-');
  if (neg) s = s.slice(1);
  if (!/^[0-9ODQILZSGB|]+$/.test(s)) return null;
  if (!allowPure && !/[0-9]/.test(s)) return null;
  const digits = s.replace(/[ODQILZSGB|]/g, (m) => CONFUSE[m]);
  return { digits, neg, conf: token.conf, raw: token.text };
}

// 도트매트릭스에서 서로 헷갈리는 숫자 쌍
const LOOKALIKE = [['0', '8'], ['0', '6'], ['0', '9'], ['6', '8'], ['3', '8'], ['1', '7']];

/** 같은 길이이고 한 자리만 다르며 그 쌍이 헷갈리기 쉬운 쌍이면 같은 번호로 본다 (예: "84" ≈ "04") */
function similarDigits(read, expected) {
  if (read.length !== expected.length) return false;
  let diff = 0, a = '', b = '';
  for (let i = 0; i < read.length; i++) if (read[i] !== expected[i]) { diff++; a = read[i]; b = expected[i]; }
  return diff === 1 && LOOKALIKE.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

function kindOf(text) {
  const t = text.toUpperCase();
  if (/AVE|AUE|VERAG|UERAG|ERAGE|RAGE/.test(t)) return 'average';
  if (/ANG|NGLE|GLE/.test(t)) return 'angle';
  if (/VALUE|ALUE|UALUE/.test(t) && !/\d{2}/.test(t)) return 'header';
  return 'row';
}

export const isAngleText = (t) => kindOf(t) === 'angle';

/** 행의 세로 위치: 기울어진 사진에서도 순서가 맞도록 엔진이 구한 rowPos(글줄 직교 좌표)를 우선 사용 */
const rowY = (line) => line.rowPos ?? (line.box.y0 + line.box.y1) / 2;

// 타격 각도로 인정하는 값 (KS F 2730 보정표/그래프 기준)
export const VALID_ANGLES = new Set([0, 15, 30, 45, 60, 90, -15, -30, -45, -60, -90]);

/**
 * ANGLE 줄 텍스트에서 각도를 뽑는다. 키워드 뒤에 붙어 읽힌 글자("ANGLEO")도 처리.
 * 유효 각도가 아니거나 신뢰도가 낮으면 null.
 */
export function parseAngleText(text, conf = 1) {
  const t = text.toUpperCase().replace(/^.*?(?:ANGLE|NGLE|ANG|GLE)/, '').trim();
  if (!t) return null;
  const tokens = t.split(/\s+/).map((s) => ({ text: s, conf }));
  const cand = tokens.map((tk) => numericOf(tk, true)).filter(Boolean);
  if (!cand.length) return null;
  const n = cand[cand.length - 1];
  const value = (n.neg ? -1 : 1) * parseInt(n.digits, 10);
  return VALID_ANGLES.has(value) ? { value, conf } : null;
}

export function parseRecord(lines) {
  const warnings = [];
  const rowLines = [];
  let average = null;
  let angle = null;
  let angleConf = null;
  let angleBox = null;
  let angleParts = null;

  for (const line of lines) {
    const kind = kindOf(line.text);
    const tokens = tokenize(line.chars?.length ? line.chars : [...line.text].map((c) => ({ c, p: line.conf })));
    if (kind === 'average') {
      // 소수점이 있는 토큰("48.8")은 numericOf 대상이 아니므로 정규식으로 직접 읽는다
      const m = line.text.match(/(\d{1,3})\s*[.,]\s*(\d)/);
      const numTok = tokens.map((t) => numericOf(t)).filter(Boolean)[0];
      if (m) {
        const decTok = tokens.find((t) => /\d[.,]\d/.test(t.text));
        average = { value: parseFloat(`${m[1]}.${m[2]}`), conf: decTok ? decTok.conf : line.conf };
      } else if (numTok) {
        const d = numTok.digits;
        // 소수점 누락 보정: "488" → 48.8
        average = { value: d.length === 3 ? parseFloat(`${d.slice(0, 2)}.${d.slice(2)}`) : parseFloat(d), conf: numTok.conf };
      }
    } else if (kind === 'angle') {
      // 외딴 글리프는 신뢰도가 낮고 오독하기 쉬워(0→9 등), 유효한 각도이면서 신뢰도가 충분할 때만 채택.
      // 그렇지 않으면 angleBox를 남겨 reader가 여러 변형으로 다시 읽어 다수결을 낸다.
      const tail = tokens.length ? Math.min(...tokens.slice(1).map((t) => t.conf), 1) : 1;
      const a = parseAngleText(line.text, tokens.length > 1 ? tail : line.conf);
      angleBox = line.quad || line.box;   // 회전 사각형이 있으면 그것을(기울어진 사진 대비)
      angleParts = line.parts ? line.parts.map((p) => p.quad).filter(Boolean) : null;
      if (a && a.conf >= 0.6) { angle = a.value; angleConf = a.conf; }
    } else if (kind === 'row') {
      const nums = tokens.map((t) => numericOf(t)).filter(Boolean);
      if (nums.length >= 2) {
        rowLines.push({ line, idx: nums[0], val: nums[1], y: rowY(line) });
      } else if (nums.length === 1 && nums[0].digits.length >= 4) {
        // 공백이 사라져 "R0146"처럼 붙은 경우: 앞 2자리 = 번호, 다음 2자리 = 값
        const d = nums[0].digits;
        rowLines.push({ line, idx: { ...nums[0], digits: d.slice(0, 2) }, val: { ...nums[0], digits: d.slice(2, 4) }, fused: true, y: rowY(line) });
      }
    }
  }

  rowLines.sort((a, b) => a.y - b.y);

  // 행 번호 부여: 읽힌 번호를 신뢰하되, 읽을 수 없으면 직전 번호 + 1 로 가정
  const rows = [];
  let last = 0;
  for (const r of rowLines) {
    const idxRead = parseInt(r.idx.digits, 10);
    let n, idxOk;
    if (idxRead === last + 1 || similarDigits(r.idx.digits, String(last + 1).padStart(2, '0'))) { n = last + 1; idxOk = true; }
    else if (idxRead > last + 1 && idxRead <= last + 4 && idxRead <= 99) { n = idxRead; idxOk = true; } // 중간 행 누락
    else { n = last + 1; idxOk = false; }
    last = n;
    let valDigits = r.val.digits;
    let flagged = false;
    if (valDigits.length > 2) { valDigits = valDigits.slice(0, 2); flagged = true; } // 막대그래프 노이즈가 붙은 경우
    const value = parseInt(valDigits, 10);
    rows.push({
      n, value, idxOk,
      conf: r.val.conf,
      box: r.line.box,
      // 확실히 의심스러운 경우 (공백 없이 붙어서 읽힘, 비정상 범위). 나머지 기준은 평균 검증 뒤에 적용한다.
      hard: !!r.fused || value < 10 || value > 80,
      soft: flagged,           // 값 뒤에 잡음 숫자가 붙었던 행 ("511" → 51)
      text: r.line.text,
    });
  }

  const count = rows.length;
  const values = rows.map((r) => r.value);
  const mean = count ? values.reduce((a, b) => a + b, 0) / count : null;
  // 기록지의 AVERAGE는 소수 첫째 자리 반올림이므로 오차 ±0.05 이내여야 일치 (부동소수 오차 여유 0.0001)
  const avgMatch = average && mean !== null ? Math.abs(mean - average.value) <= 0.0501 : null;

  const seqOk = rows.every((r, i) => r.n === i + 1);
  if (!count) warnings.push('측정값 행(R01…)을 찾지 못했습니다.');
  if (count && !seqOk) warnings.push('행 번호가 연속되지 않습니다. 누락된 행이 있는지 확인하세요.');
  if (average && avgMatch === false) warnings.push(`인식값의 평균(${mean.toFixed(2)})이 기록지의 AVERAGE(${average.value})와 다릅니다. 표시된 행을 원본과 대조하세요.`);
  if (!average) warnings.push('AVERAGE 줄을 읽지 못했습니다.');
  if (angle === null) warnings.push('ANGLE 값을 읽지 못했습니다. 직접 입력해 주세요.');

  // 검토 표시는 "값"의 신뢰만 본다 (번호 글자를 못 읽어도 순서로 보정되므로 값과는 무관).
  // 기록지의 AVERAGE 와 일치하면 숫자별 신뢰도가 낮아도 맞게 읽은 경우가 대부분이라 기준을 크게 낮춘다.
  const confLimit = avgMatch === true ? 0.3 : 0.6;
  for (const r of rows) r.review = r.hard || (avgMatch !== true && r.soft) || r.conf < confLimit;

  const idxOkCount = rows.filter((r) => r.idxOk).length;
  const score =
    idxOkCount + rows.length * 0.5 +
    (avgMatch ? 25 : 0) + (seqOk ? 3 : 0) -
    rows.filter((r) => r.review).length * 0.3;

  // 결과기록지로 볼 수 있는가? (그래프·표 같은 숫자 이미지에서 엉뚱한 값을 채우지 않도록)
  //  - AVERAGE 줄이 있거나, 번호가 1부터 이어지는 행이 대부분이어야 한다
  const startsAtOne = count > 0 && rows[0].n === 1;
  const valid = count >= 3 && (average !== null || (startsAtOne && idxOkCount / count >= 0.7));

  return { rows, count, average, angle, angleConf, angleBox, angleParts, mean, avgMatch, seqOk, valid, warnings, score };
}

/** 값이 유효 각도로 확정된 뒤 'ANGLE 읽지 못함' 경고를 지운다 */
export function clearAngleWarning(rec) {
  rec.warnings = rec.warnings.filter((w) => !w.startsWith('ANGLE'));
}
