// 실행: node --test tests/
// 타점 원의 중심 간격이 인쇄물에서 가로·세로 모두 3cm 인지 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { GRID } from '../js/sheet.js';
import { buildPdf } from '../js/pdf.js';

const PAGE_W = 1342;                           // 양식의 설계 크기(px)
const JPEG = Uint8Array.from(Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64'));

test('격자: 가로·세로 간격이 같고 5×4 = 20칸', () => {
  assert.equal(GRID.dx, GRID.dy);
  assert.equal(GRID.cols * GRID.rows, 20);
});

test('브라우저 인쇄: 원 중심 간격 = 30mm (인쇄 배율은 css/app.css 의 @media print --k)', () => {
  const css = fs.readFileSync(new URL('../css/app.css', import.meta.url), 'utf8');
  const k = Number(/@media print[\s\S]*?\.sheet-host\s*\{\s*--k:\s*([\d.]+)/.exec(css)?.[1]);
  assert.ok(k > 0.5 && k < 1, `인쇄 배율을 찾지 못했습니다 (${k})`);
  const mm = GRID.dx * k * 25.4 / 96;
  assert.ok(Math.abs(mm - 30) < 0.1, `가로 간격 ${mm.toFixed(3)}mm`);
  assert.ok(Math.abs(GRID.dy * k * 25.4 / 96 - 30) < 0.1);
});

test('PDF 저장: 원 중심 간격 = 30mm (A4 가로, 여백 8mm 에 맞춘 배율)', () => {
  const pdf = Buffer.from(buildPdf([{ jpeg: JPEG, width: Math.round(PAGE_W * 1.75), height: Math.round(926 * 1.75) }])).toString('latin1');
  const w = Number(/q ([\d.]+) 0 0 [\d.]+ [\d.]+ [\d.]+ cm \/Im0 Do Q/.exec(pdf)[1]);     // 양식 전체 너비(pt)
  const mmPerPx = (w * 25.4 / 72) / PAGE_W;
  assert.ok(Math.abs(GRID.dx * mmPerPx - 30) < 0.15, `가로 간격 ${(GRID.dx * mmPerPx).toFixed(3)}mm`);
  assert.ok(Math.abs(GRID.dy * mmPerPx - 30) < 0.15, `세로 간격 ${(GRID.dy * mmPerPx).toFixed(3)}mm`);
});

test('격자가 양식의 다른 요소와 겹치지 않는다 (아래 설명문 위, 오른쪽 타격방향 그림 왼쪽)', () => {
  const lastX = GRID.x0 + (GRID.cols - 1) * GRID.dx, lastY = GRID.y0 + (GRID.rows - 1) * GRID.dy;
  assert.ok(lastX + GRID.padRight < 790, `가로 끝 ${lastX + GRID.padRight} (타격방향 그림은 x=790부터)`);
  assert.ok(lastY + GRID.r < 566, `세로 끝 ${lastY + GRID.r} (설명문은 y=566부터)`);
  assert.ok(GRID.y0 - GRID.r > 34, '첫 줄 원이 현장명 줄(~y=31)과 겹치면 안 된다');
  assert.ok(GRID.x0 + (GRID.cols - 1) * GRID.dx + GRID.padRight < 720, 'SVG 너비(720) 안');
});
