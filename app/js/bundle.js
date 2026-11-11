// 문서 묶음 내보내기(ZIP)와 가져오기, 문서 한 건의 PDF 만들기.
//
// ZIP 구성 (시험일별 폴더):
//   슈미트해머_2026-11-10_3건.zip
//   ├─ 목록.csv                      엑셀에서 바로 열리는 요약표 (현장·위치·R₀·Fc·판정 등)
//   ├─ 데이터.json                   이 앱으로 다시 가져올 수 있는 원본 데이터 (사진 위치 포함)
//   └─ 2026-11-10/
//        ├─ 01_테스트 현장_3층 기둥.pdf             데이터시트 2쪽(A4 가로) + 사진대지(A4 세로, 사진 2장당 1쪽)
//        ├─ 01_테스트 현장_3층 기둥_기록지.jpg      결과기록지 사진
//        └─ 01_테스트 현장_3층 기둥_사진-1.jpg …    사진대지에 넣은 현장 사진
import {
  DOC_FORMAT, DOC_VERSION, SHOTS_PER_PAGE, photoPageCount, stateFromDoc, calcFor, fileBase, groupByDate, toCsv, bundleName, safeName, sanitizeDoc, titleOf,
} from './docs.js';
import { renderSheet } from './sheet.js';
import { pageToCanvas, canvasToBlob } from './sheetimage.js';
import { buildPhotoPage, fillPhotoPage, drawShots, photoTexts, PHOTO_PAGE } from './photosheet.js';
import { getSheetText } from './settings.js';
import { buildPdf } from './pdf.js';
import { ZipWriter, readZip } from './zip.js';
import * as db from './store.js';

const A4_PORTRAIT = { pageWidth: 595.28, pageHeight: 841.89, margin: 0 };      // 사진대지 쪽은 설계 크기(794×1123px)가 곧 A4 이므로 여백 없이 꽉 채운다

/**
 * 문서 한 건을 양식 그대로 PDF 로 만든다: 데이터시트 2쪽 + (현장 사진이 있으면) 사진대지.
 * 화면에 열려 있는 양식(#sheetHost)을 복제해서 거기에 그리므로, 편집 중인 내용에는 영향이 없다.
 * @param {object} doc
 * @param {object} [o]
 * @param {(shotId:string)=>Promise<Blob|null>} [o.getShot]  사진대지 사진을 가져오는 함수 (기본: 문서함 저장소). 저장 전의 새 사진을 쓰려면 지정
 */
export async function renderDocPdf(doc, { scale = 1.75, photoScale = 2, quality = 0.9, getShot } = {}) {
  const host = document.getElementById('sheetHost');
  if (!host) throw new Error('양식 화면을 찾지 못했습니다');
  const root = host.cloneNode(true);
  const state = stateFromDoc(doc);
  renderSheet(state, calcFor(state), root);
  const pages = [];
  const t0 = performance.now(), lap = [];
  const mark = (s) => lap.push(`${s}${Math.round(performance.now() - t0)}`);
  const addPage = async (canvas, extra = {}) => {
    mark('그림');
    const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
    pages.push({ jpeg: new Uint8Array(await blob.arrayBuffer()), width: canvas.width, height: canvas.height, ...extra });
    mark('JPEG');
    canvas.width = canvas.height = 0;                       // 메모리를 바로 돌려준다 (모바일)
  };
  for (const sel of ['#page1', '#page2']) await addPage(await pageToCanvas(root.querySelector(sel), scale));

  // 사진대지: 사진 2장당 한 쪽
  const shots = doc.shots || [];
  if (shots.length) {
    const read = getShot || ((id) => db.getShot(doc.id, id));
    const texts = photoTexts(doc, getSheetText());
    for (let p = 0; p < photoPageCount(shots.length); p++) {
      const group = shots.slice(p * SHOTS_PER_PAGE, (p + 1) * SHOTS_PER_PAGE);
      const bitmaps = [];
      for (const s of group) {
        const blob = await read(s.id);
        bitmaps.push(blob ? await createImageBitmap(blob) : null);
      }
      const page = buildPhotoPage();
      fillPhotoPage(page, texts, group.map((s, i) => (bitmaps[i] ? { url: '' } : null)), doc.shotFit);   // 사진은 아래에서 캔버스에 직접 그린다 (여기서는 "사진-N" 안내만 숨긴다)
      const canvas = await pageToCanvas(page, photoScale, {
        width: PHOTO_PAGE.w, height: PHOTO_PAGE.h, after: (ctx, s) => drawShots(ctx, s, bitmaps, doc.shotFit),
      });
      bitmaps.forEach((b) => b?.close?.());
      await addPage(canvas, A4_PORTRAIT);
    }
  }
  console.log(`[pdf] ${lap.join(' ')} ms (누적)`);        // 앱에서는 adb logcat -s SchmidtDatasheet 로 볼 수 있다
  return buildPdf(pages, { title: ['슈미트해머 데이터시트', doc.site, doc.testDate].filter(Boolean).join(' ') });
}

/** 단일 PDF 의 파일 이름. 예) "슈미트해머_테스트 현장_3층 기둥_2026-11-10.pdf" */
export function pdfName(doc) {
  return `${['슈미트해머', safeName(doc.site), safeName(doc.location), doc.testDate].filter(Boolean).join('_')}.pdf`;
}

const abortError = () => Object.assign(new Error('중단했습니다'), { name: 'AbortError' });
const nfc = (s) => String(s).normalize('NFC');           // readZip 이 돌려주는 항목 이름은 NFC (zip.js)

/**
 * 문서들을 ZIP 한 개로 묶는다.
 * @param {object[]} docs
 * @param {object} [o]
 * @param {boolean} [o.pdf=true]     양식 PDF 포함
 * @param {boolean} [o.photos=true]  사진(결과기록지·사진대지) 포함
 * @param {(done:number,total:number,label:string)=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{blob:Blob, name:string, count:number}>}
 */
export async function buildBundle(docs, { pdf = true, photos = true, onProgress, signal } = {}) {
  const zip = new ZipWriter();
  const csvItems = [];
  const exported = [];
  let done = 0;
  for (const group of groupByDate(docs)) {
    const folder = group.date || '시험일 없음';
    for (let i = 0; i < group.docs.length; i++) {
      if (signal?.aborted) throw abortError();
      const doc = group.docs[i];
      onProgress?.(done, docs.length, `${folder} · ${titleOf(doc)}${doc.location ? ` · ${doc.location}` : ''}`);
      const base = `${folder}/${fileBase(doc, i)}`;
      let pdfFile = '';
      if (pdf) {
        pdfFile = `${base}.pdf`;
        await zip.add(pdfFile, await renderDocPdf(doc));
      }
      let photoFile = '';
      if (photos && doc.photo) {
        const blob = await db.getPhoto(doc.id);
        if (blob) { photoFile = `${base}_기록지.jpg`; await zip.add(photoFile, blob); }
      }
      const shotFiles = {};
      if (photos) {
        for (let k = 0; k < (doc.shots || []).length; k++) {
          const s = doc.shots[k];
          const blob = await db.getShot(doc.id, s.id);
          if (blob) { shotFiles[s.id] = `${base}_사진-${k + 1}.jpg`; await zip.add(shotFiles[s.id], blob); }
        }
      }
      csvItems.push({ doc, file: pdfFile || photoFile });
      exported.push({ ...doc, ...(photoFile ? { photoFile } : {}), ...(Object.keys(shotFiles).length ? { shotFiles } : {}) });
      done++;
    }
  }
  if (signal?.aborted) throw abortError();
  onProgress?.(docs.length, docs.length, '목록 정리');
  await zip.add('목록.csv', toCsv(csvItems));
  await zip.add('데이터.json', JSON.stringify({ app: DOC_FORMAT, version: DOC_VERSION, exportedAt: new Date().toISOString(), documents: exported }, null, 1));
  return { blob: zip.finish(), name: bundleName(docs), count: docs.length };
}

/**
 * 내보냈던 ZIP(또는 데이터.json)을 문서함으로 가져온다.
 *  · 같은 문서(id)가 이미 있으면 더 나중에 고친 쪽을 남긴다 (이미 최신이면 건너뜀)
 *  · 가져온 값은 믿지 않고 sanitizeDoc 으로 모양을 바로잡는다
 * @returns {Promise<{added:number, updated:number, skipped:number, invalid:number, photos:number}>}
 */
export async function importBundle(file, { onProgress } = {}) {
  let manifest;
  let entries = new Map();
  if (/\.json$/i.test(file.name) || file.type === 'application/json') {
    manifest = JSON.parse((await file.text()).replace(/^﻿/, ''));
  } else {
    entries = new Map((await readZip(file)).map((e) => [e.name, e]));
    const m = entries.get('데이터.json');
    if (!m) throw new Error('이 ZIP 에는 데이터.json 이 없습니다. 이 앱의 [ZIP으로 내보내기]로 만든 파일이 아닙니다.');
    manifest = JSON.parse(await m.text());
  }
  if (!manifest || manifest.app !== DOC_FORMAT || !Array.isArray(manifest.documents)) throw new Error('이 앱에서 내보낸 데이터가 아닙니다.');

  const current = new Map((await db.listDocs()).map((d) => [d.id, d]));
  const result = { added: 0, updated: 0, skipped: 0, invalid: 0, photos: 0 };
  let n = 0;
  for (const raw of manifest.documents) {
    onProgress?.(n++, manifest.documents.length);
    const doc = sanitizeDoc(raw);
    if (!doc) { result.invalid++; continue; }
    const prev = current.get(doc.id);
    if (prev && prev.updatedAt >= doc.updatedAt) { result.skipped++; continue; }

    let photo;                                                    // undefined = 기존 사진을 그대로 둔다
    const entry = doc.photo && typeof raw.photoFile === 'string' ? entries.get(nfc(raw.photoFile)) : null;
    if (entry) {
      photo = new Blob([await entry.bytes()], { type: 'image/jpeg' });
      result.photos++;
    } else if (doc.photo) {
      if (prev?.photo) doc.photo = prev.photo;                    // 사진 없이 내보낸 파일: 이 기기에 있는 사진을 유지
      else doc.photo = null;                                      // 사진 파일이 없으면 사진 정보도 버린다
    } else if (prev?.photo) {
      photo = null;                                               // 가져온 쪽이 더 최신이고 사진이 없다 → 사진 삭제
    }

    // 사진대지 사진: ZIP 에 파일이 있으면 가져오고, 없으면 이 기기에 같은 사진이 있을 때만 유지, 그 밖에는 목록에서 뺀다
    const prevShotIds = new Set((prev?.shots || []).map((s) => s.id));
    const keptShots = [];
    const blobs = [];
    for (const s of doc.shots) {
      const path = raw.shotFiles && typeof raw.shotFiles[s.id] === 'string' ? raw.shotFiles[s.id] : '';
      const e = path ? entries.get(nfc(path)) : null;
      if (e) { blobs.push([s.id, new Blob([await e.bytes()], { type: 'image/jpeg' })]); keptShots.push(s); result.photos++; }
      else if (prevShotIds.has(s.id)) keptShots.push(s);
    }
    doc.shots = keptShots;
    for (const [id, blob] of blobs) await db.putShot(doc.id, id, blob);         // 사진을 먼저 쓰고 문서를 나중에 쓴다 (문서가 없는 사진을 가리키지 않게)
    await db.putDoc(doc, photo);
    const keep = new Set(keptShots.map((s) => s.id));
    await db.removeShots(doc.id, [...prevShotIds].filter((id) => !keep.has(id)));
    current.set(doc.id, doc);
    if (prev) result.updated++; else result.added++;
  }
  onProgress?.(manifest.documents.length, manifest.documents.length);
  return result;
}
