// 배포용 폴더 만들기:  node tools/build-pwa.mjs <출력폴더>     (예: node app/tools/build-pwa.mjs _site)
//
// app/ 에서 배포에 필요한 파일만 골라 복사하고(로컬 서버·시험·개발 도구는 제외),
// 서비스 워커(sw.js)가 읽는 precache.js 를 만든다: { 버전(= 파일 내용 해시), 미리 저장할 파일 목록 }.
// 파일이 하나라도 바뀌면 버전이 바뀌어 앱이 새 버전으로 교체된다.
//
// 의존성 없음(Node 18+). GitHub Actions(.github/workflows/pages.yml)가 이 스크립트로 GitHub Pages 에 올릴 폴더를 만든다.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const appDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.resolve(process.argv[2] || '_site');

// 출력 폴더는 매번 통째로 지우고 다시 만든다 → 실수로 app/ 이나 그 상위 폴더(저장소 루트 등), 현재 폴더, 디스크 루트를 가리키면 거부한다
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
if (inside(outDir, appDir) || outDir === path.resolve(process.cwd()) || outDir === path.parse(outDir).root) {
  console.error(`출력 폴더가 위험합니다: ${outDir}\n  app/ 이나 그 상위 폴더, 현재 폴더, 디스크 루트는 쓸 수 없습니다. 새 폴더 이름을 주세요. 예: node app/tools/build-pwa.mjs _site`);
  process.exit(1);
}

// 배포 대상 (app/ 기준). vendor 는 onnxruntime-web 만 (QR 페이지용 vendor/qrcode 는 같은 Wi-Fi 서버 전용이라 제외)
const INCLUDE = ['index.html', 'manifest.webmanifest', 'sw.js', 'NOTICE.md', 'css', 'js', 'assets', 'models', 'samples', 'icons', 'vendor/ort'];
// 오프라인 실행에 필요한 것 (NOTICE.md 는 배포만 하고 미리 저장하지 않는다)
const NOT_PRECACHED = new Set(['sw.js', 'precache.js', 'NOTICE.md']);
const REQUIRED = ['index.html', 'manifest.webmanifest', 'sw.js', 'js/main.js', 'js/pwa.js', 'models/det.onnx', 'models/rec.onnx', 'models/dict.txt',
  'vendor/ort/ort-wasm-simd-threaded.wasm', 'vendor/ort/ort.wasm.bundle.min.mjs', 'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png'];

function* walk(rel) {
  const full = path.join(appDir, rel);
  if (!fs.existsSync(full)) throw new Error(`배포에 필요한 파일/폴더가 없습니다: app/${rel}`);
  const st = fs.statSync(full);
  if (st.isFile()) { yield rel.replaceAll('\\', '/'); return; }
  for (const name of fs.readdirSync(full).sort()) yield* walk(path.join(rel, name));
}

const files = INCLUDE.flatMap((p) => [...walk(p)]);
for (const r of REQUIRED) if (!files.includes(r)) throw new Error(`필수 파일이 빠졌습니다: app/${r}`);

fs.rmSync(outDir, { recursive: true, force: true });
const hash = crypto.createHash('sha256');
let bytes = 0;
for (const rel of files) {
  const src = path.join(appDir, rel);
  const dst = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const data = fs.readFileSync(src);
  fs.writeFileSync(dst, data);
  hash.update(rel).update('\0').update(crypto.createHash('sha256').update(data).digest());
  bytes += data.length;
}

const version = hash.digest('hex').slice(0, 12);
const precache = ['./', ...files.filter((f) => !NOT_PRECACHED.has(f))];
fs.writeFileSync(path.join(outDir, 'precache.js'),
  `// build-pwa.mjs 가 만든 파일 — 서비스 워커가 읽는다 (직접 고치지 말 것)\nself.PRECACHE = ${JSON.stringify({ version, files: precache }, null, 1)};\n`);
fs.writeFileSync(path.join(outDir, '.nojekyll'), '');          // GitHub Pages 가 파일을 가공(Jekyll)하지 않게

console.log(`배포 폴더: ${outDir}`);
console.log(`  파일 ${files.length}개, ${(bytes / 1048576).toFixed(1)}MB, 미리 저장 ${precache.length}개, 버전 ${version}`);
