// OCR 회귀 테스트: 샘플 결과기록지(samples/sample-record.jpg)를 Node 에서 실제 모델로 읽어 정답과 비교한다.
// 엔진/파서/리더를 고친 뒤 인식률이 떨어지지 않았는지 확인하는 용도.
//
// 필요한 개발 의존성 (없으면 이 테스트는 건너뜀):   npm install        (package.json 의 devDependencies)
// 실행:                                              npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

let ort = null, sharp = null;
try { ort = await import('onnxruntime-node'); sharp = (await import('sharp')).default; } catch { /* 설치 안 됨 */ }
const skip = !ort || !sharp ? 'onnxruntime-node / sharp 가 설치되어 있지 않아 건너뜀 (npm install)' : false;

const app = (p) => fileURLToPath(new URL(`../${p}`, import.meta.url));
const TRUTH = [46, 49, 50, 49, 51, 48, 48, 49, 49, 48, 51, 48, 50, 48, 45, 52, 48, 47, 48, 51];   // 샘플 기록지의 R01~R20
const toRgba = async (s) => {
  const { data, info } = await s.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data: new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
};

let engine, readRecord, ops;
if (!skip) {
  const { PaddleEngine } = await import('../js/ocr/engine.js');
  ({ readRecord } = await import('../js/ocr/reader.js'));
  ops = await import('../js/ocr/imageops.js');
  engine = await PaddleEngine.create({
    ort,
    det: new Uint8Array(fs.readFileSync(app('models/det.onnx'))),
    rec: new Uint8Array(fs.readFileSync(app('models/rec.onnx'))),
    dict: fs.readFileSync(app('models/dict.txt'), 'utf8'),
  });
}

const expectSample = (rec, label) => {
  const got = TRUTH.map((_, i) => rec.rows.find((r) => r.n === i + 1)?.value);
  assert.deepEqual(got, TRUTH, `${label}: R01~R20`);
  assert.equal(rec.average?.value, 48.8, `${label}: AVERAGE`);
  assert.equal(rec.avgMatch, true, `${label}: 평균 검증`);
  assert.equal(rec.angle, 0, `${label}: ANGLE`);
  assert.equal(rec.valid, true);
};

test('샘플 기록지: 20개 값 + AVERAGE + ANGLE', { skip }, async () => {
  expectSample(await readRecord(engine, await toRgba(sharp(app('samples/sample-record.jpg')).rotate())), '원본');
});

test('해상도를 절반으로 줄여도 읽는다', { skip }, async () => {
  expectSample(await readRecord(engine, await toRgba(sharp(app('samples/sample-record.jpg')).rotate().resize({ width: 533 }))), '50%');
});

test('뒤집히거나 누운 사진도 방향을 찾아서 읽는다 (90/180/270°)', { skip }, async () => {
  const base = await toRgba(sharp(app('samples/sample-record.jpg')).rotate());
  for (const deg of [90, 180, 270]) expectSample(await readRecord(engine, ops.rotate(base, deg)), `${deg}° 회전`);
});

test('기록지가 아닌 이미지는 기록지로 판정하지 않는다', { skip }, async () => {
  const rec = await readRecord(engine, await toRgba(sharp(app('assets/chart-direction.png'))));
  assert.equal(rec.valid, false);
});
