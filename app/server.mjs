// 의존성 없는 정적 서버.
//   node server.mjs            이 PC 에서만 접속 (localhost)
//   node server.mjs --lan      같은 Wi-Fi/랜의 다른 기기(휴대폰)에서도 접속 — start-phone.bat 이 이 모드로 실행
//   node server.mjs 5174       포트 지정
//
// 왜 서버가 필요한가: OCR 엔진(WebAssembly/ONNX 모델)은 file:// 로 열면 브라우저가 로딩을 막습니다.
// 배포할 때는 이 파일 없이 app 폴더를 아무 웹서버(IIS, nginx, GitHub Pages 등)에 올리면 됩니다.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import qrcode from './vendor/qrcode/qrcode.mjs';

// ROOT=<폴더> 로 다른 폴더를 서비스할 수 있다 (예: PWA 배포 폴더를 로컬에서 시험: ROOT=_site node server.mjs 5175)
const root = process.env.ROOT ? path.resolve(process.env.ROOT) : path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const lan = args.includes('--lan') || process.env.LAN === '1';
const port = Number(args.find((a) => /^\d+$/.test(a)) || process.env.PORT || 5173);
const host = lan ? '0.0.0.0' : '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.onnx': 'application/octet-stream',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/** 이 PC 의 LAN 주소들 (Wi-Fi/유선을 앞에, 가상 어댑터는 뒤에) */
function lanAddresses() {
  const found = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (!(a.family === 'IPv4' || a.family === 4) || a.internal || a.address.startsWith('169.254.')) continue;
      const priv = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a.address);
      const virtual = /vethernet|vmware|virtualbox|wsl|hyper-v|docker|bluetooth|loopback/i.test(name);
      found.push({ name, address: a.address, url: `http://${a.address}:${port}/`, rank: (priv ? 0 : 2) + (virtual ? 1 : 0) });
    }
  }
  return found.sort((x, y) => x.rank - y.rank).map(({ rank, ...rest }) => rest);
}

const isLocalHost = (h) => ['localhost', '127.0.0.1', '[::1]'].includes((h || '').replace(/:\d+$/, ''));

const server = http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, { Allow: 'GET, HEAD' }).end(); return; }
  let rel;
  try { rel = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400).end('Bad request'); return; }

  // phone.html 이 QR 을 만들 때 쓰는 접속 주소 목록
  if (rel === '/__lan.json') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ lan, port, addresses: lan ? lanAddresses() : [] }));
    return;
  }

  const base = root;
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(base, rel));
  if (!file.startsWith(base)) { res.writeHead(403).end('Forbidden'); return; }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('Not found'); return; }
    const headers = {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      // 매번 서버에 확인하되(no-cache) 바뀌지 않았으면 304 로 응답해 30MB 가량의 모델/WASM 을 다시 받지 않는다
      'Cache-Control': 'no-cache',
      'Last-Modified': st.mtime.toUTCString(),
    };
    // 교차 출처 격리: ONNX Runtime 의 멀티스레드(WASM threads)를 켜서 인식 속도를 높인다.
    // 보안 컨텍스트(localhost 또는 https)에서만 의미가 있다 — http://192.168.x.x 로 접속한 휴대폰은 단일 스레드로 동작한다.
    if (isLocalHost(req.headers.host)) {
      headers['Cross-Origin-Opener-Policy'] = 'same-origin';
      headers['Cross-Origin-Embedder-Policy'] = 'require-corp';
    }
    const since = Date.parse(req.headers['if-modified-since'] || '');
    if (!Number.isNaN(since) && Math.floor(st.mtimeMs / 1000) * 1000 <= since) { res.writeHead(304, headers).end(); return; }
    res.writeHead(200, { ...headers, 'Content-Length': st.size });
    if (req.method === 'HEAD') res.end(); else fs.createReadStream(file).pipe(res);
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`포트 ${port} 가 이미 사용 중입니다. 다른 포트로 실행: node server.mjs${lan ? ' --lan' : ''} 5174`);
  else console.error(e);
  process.exit(1);
});

/** 터미널에 QR 을 그린다 (어두운 터미널에서도 읽히도록 흰 바탕 + 검정 모듈, 위아래 반블록으로 2줄을 1줄에) */
function printQr(text) {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount(), q = 2;
  const dark = (r, c) => r >= 0 && c >= 0 && r < n && c < n && qr.isDark(r, c);
  const rows = [];
  for (let r = -q; r < n + q; r += 2) {
    let line = '\x1b[30;47m';
    for (let c = -q; c < n + q; c++) {
      const t = dark(r, c), b = dark(r + 1, c);
      line += t && b ? '█' : t ? '▀' : b ? '▄' : ' ';
    }
    rows.push(`  ${line}\x1b[0m`);
  }
  console.log(rows.join('\n'));
}

server.listen(port, host, () => {
  const local = `http://localhost:${port}/`;
  console.log(`슈미트해머 데이터시트: ${local}  (종료: Ctrl+C 또는 이 창 닫기)`);
  if (lan) {
    const addrs = lanAddresses();
    if (!addrs.length) console.log('\n연결된 Wi-Fi/랜 주소를 찾지 못했습니다. PC 의 네트워크 연결을 확인하세요.');
    else {
      console.log('\n[휴대폰에서 열기]  폰을 PC 와 같은 Wi-Fi 에 연결하고, 카메라로 아래 QR 을 스캔하거나 주소를 입력하세요.');
      for (const a of addrs) console.log(`   ${a.url}   (${a.name})`);
      if (process.stdout.isTTY) { console.log(''); printQr(addrs[0].url); }
      console.log('\n※ 이 창을 닫으면 폰에서도 접속이 끊깁니다. 같은 네트워크의 기기만 접속할 수 있습니다.');
    }
  }
  if (!process.env.NO_OPEN) {
    const url = lan ? `${local}phone.html` : local;
    const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
    exec(cmd);
  }
});
