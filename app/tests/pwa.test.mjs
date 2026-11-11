// 실행: node --test tests/
// PWA 배포 빌드(tools/build-pwa.mjs)가 빠짐없이, 재현 가능하게 만들어지는지 확인한다.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(app, 'tools', 'build-pwa.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'schmidt-pwa-'));
const build = (name) => {
  const out = path.join(tmp, name);
  execFileSync(process.execPath, [script, out], { stdio: 'pipe' });
  const ctx = { self: {} };
  vm.runInNewContext(fs.readFileSync(path.join(out, 'precache.js'), 'utf8'), ctx);       // 서비스 워커가 importScripts 로 읽는 것과 같은 방식
  return { out, pre: ctx.self.PRECACHE };
};
const A = build('a');

test('precache.js: 버전·파일 목록 모양, 모든 파일이 실제로 있다', () => {
  assert.match(A.pre.version, /^[0-9a-f]{12}$/);
  assert.equal(A.pre.files[0], './');
  assert.ok(A.pre.files.length > 30);
  assert.equal(new Set(A.pre.files).size, A.pre.files.length, '중복 없음');
  for (const f of A.pre.files.slice(1)) assert.ok(fs.existsSync(path.join(A.out, f)), `빠진 파일: ${f}`);
});

test('오프라인 실행에 필요한 것이 모두 미리 저장 목록에 있다 (OCR 모델·wasm·양식 CSS·보정 그래프·아이콘)', () => {
  for (const f of ['index.html', 'manifest.webmanifest', 'css/app.css', 'js/main.js', 'js/pwa.js', 'js/ocr/loader.js', 'js/ocr/probe-worker.js',
    'models/det.onnx', 'models/rec.onnx', 'models/dict.txt', 'vendor/ort/ort-wasm-simd-threaded.wasm', 'vendor/ort/ort-wasm-simd-threaded.mjs',
    'vendor/ort/ort.wasm.bundle.min.mjs', 'assets/chart-direction.png', 'samples/sample-record.jpg', 'icons/icon-192.png', 'icons/apple-touch-icon.png']) {
    assert.ok(A.pre.files.includes(f), `미리 저장 목록에 없음: ${f}`);
  }
});

test('서비스 워커·목록 자신·로컬 서버/시험 파일은 미리 저장하지도 배포하지도 않는다', () => {
  for (const f of ['sw.js', 'precache.js', 'NOTICE.md']) assert.ok(!A.pre.files.includes(f), `${f} 는 미리 저장 대상이 아님`);
  assert.ok(fs.existsSync(path.join(A.out, 'sw.js')), 'sw.js 는 배포한다');
  for (const f of ['server.mjs', 'package.json', 'phone.html', 'start.bat', 'tests', 'tools', 'vendor/qrcode']) {
    assert.ok(!fs.existsSync(path.join(A.out, f)), `배포하면 안 되는 것: ${f}`);
  }
});

test('같은 소스로 두 번 빌드하면 버전(내용 해시)이 같다', () => {
  assert.equal(build('b').pre.version, A.pre.version);
});

test('매니페스트: 필수 항목과 아이콘 파일', () => {
  const m = JSON.parse(fs.readFileSync(path.join(A.out, 'manifest.webmanifest'), 'utf8'));
  assert.deepEqual([m.start_url, m.scope, m.display], ['./', './', 'standalone']);
  assert.ok(m.name && m.short_name && m.theme_color && m.background_color);
  assert.ok(m.icons.some((i) => i.sizes === '192x192') && m.icons.some((i) => i.sizes === '512x512') && m.icons.some((i) => i.purpose === 'maskable'));
  for (const i of m.icons) assert.ok(fs.existsSync(path.join(A.out, i.src)), `아이콘 없음: ${i.src}`);
});

test('index.html: 매니페스트·아이폰 설정·서비스 워커 등록 모듈', () => {
  const html = fs.readFileSync(path.join(A.out, 'index.html'), 'utf8');
  for (const s of ['rel="manifest"', 'rel="apple-touch-icon"', 'apple-mobile-web-app-capable', 'viewport-fit=cover', 'name="theme-color"']) assert.ok(html.includes(s), `index.html 에 없음: ${s}`);
  assert.match(fs.readFileSync(path.join(A.out, 'js', 'main.js'), 'utf8'), /initPwa\(\)/);
  assert.match(fs.readFileSync(path.join(A.out, 'js', 'pwa.js'), 'utf8'), /serviceWorker\.register\('sw\.js'/);
});

test('배포 폴더 안의 모든 JS 모듈이 import 하는 상대 경로 파일이 배포 폴더에 있다', () => {
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of walk(path.join(A.out, 'js'))) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      assert.ok(fs.existsSync(path.resolve(path.dirname(f), m[1])), `${path.relative(A.out, f)} 가 가져오는 ${m[1]} 가 배포 폴더에 없음`);
    }
  }
});

test('서비스 워커 문법과 핵심 동작(캐시 이름·SKIP_WAITING)', () => {
  const sw = fs.readFileSync(path.join(A.out, 'sw.js'), 'utf8');
  new vm.Script(sw);                                                  // 문법 검사
  assert.match(sw, /importScripts\('precache\.js'\)/);
  assert.match(sw, /SKIP_WAITING/);
  assert.match(sw, /caches\.delete/);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
