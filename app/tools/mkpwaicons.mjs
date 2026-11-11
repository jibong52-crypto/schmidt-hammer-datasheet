// PWA 아이콘 만들기 (한 번 실행해 icons/ 에 PNG 를 만든다): node tools/mkpwaicons.mjs   (sharp 필요: npm install)
//  · apple-touch-icon.png  180x180  아이폰 홈 화면용 — iOS 가 모서리를 직접 둥글게 깎으므로 모서리 없이 꽉 채운다
//  · icon-192.png / icon-512.png    안드로이드·크롬용 (둥근 모서리)
//  · icon-maskable-512.png          안드로이드 적응형 아이콘용 — 가운데 80% 안전 영역 안에 그린다
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const out = process.argv[2] ? path.resolve(process.argv[2]) : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'icons');
fs.mkdirSync(out, { recursive: true });
const BLUE = '#1f5fbf';

/** 파란 바탕에 흰 링 (앱 로고와 같은 모양). rounded: 모서리 비율, ring: 링 반지름 비율 */
const svg = (size, { rounded = 0, ring = 0.22, stroke = 0.078 } = {}) => `
<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <rect width="${size}" height="${size}" rx="${size * rounded}" fill="${BLUE}"/>
  <circle cx="${size / 2}" cy="${size / 2}" r="${size * ring}" fill="none" stroke="#fff" stroke-width="${size * stroke}"/>
</svg>`;

const jobs = [
  ['apple-touch-icon.png', 180, { rounded: 0 }],
  ['icon-192.png', 192, { rounded: 0.22 }],
  ['icon-512.png', 512, { rounded: 0.22 }],
  ['icon-maskable-512.png', 512, { rounded: 0, ring: 0.17, stroke: 0.06 }],
];
for (const [name, size, opt] of jobs) {
  await sharp(Buffer.from(svg(size, opt))).png({ compressionLevel: 9 }).toFile(path.join(out, name));
  console.log('만듦:', name, `${size}x${size}`);
}
