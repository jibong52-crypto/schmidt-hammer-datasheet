// 결과기록지 사진 여러 장을 차례로 읽어 문서로 저장한다 (문서함의 [사진으로 여러 장 추가]).
import { decodeImage } from './ocr/loader.js';
import { readRecord } from './ocr/reader.js';
import { docFromRecord, todayStr } from './docs.js';
import { storedPhoto } from './photo.js';
import { exifPhotoDate } from './exif.js';
import * as db from './store.js';

const tick = () => new Promise((r) => setTimeout(r, 0));      // 화면(진행 막대)이 갱신될 틈을 준다

/**
 * @param {File[]} files
 * @param {object} common  모든 문서에 넣을 값 { testDate, pourDate, site, tester, supervisor, useFileDate }
 * @param {object} o
 * @param {()=>Promise<object>} o.ensureEngine   OCR 엔진 (처음 한 번만 불러온다)
 * @param {(ev:object)=>void} [o.onItem]         { index, total, name, phase:'start'|'progress'|'saved'|'failed', frac?, text?, doc?, message? }
 * @param {AbortSignal} [o.signal]
 * @returns {Promise<{saved:{name:string, doc:object, avgMatch:boolean|null}[], failed:{name:string, message:string}[], aborted:boolean}>}
 */
export async function importPhotos(files, common, { ensureEngine, onItem, signal } = {}) {
  const saved = [], failed = [];
  const total = files.length;
  const engine = await ensureEngine();
  let aborted = false;

  for (let index = 0; index < total; index++) {
    if (signal?.aborted) { aborted = true; break; }
    const file = files[index];
    const name = file.name || `사진 ${index + 1}`;
    const emit = (phase, extra = {}) => onItem?.({ index, total, name, phase, ...extra });
    emit('start');
    await tick();
    try {
      let img;
      try { img = await decodeImage(file); } catch { throw new Error('이미지를 열 수 없습니다 (JPG/PNG 로 저장해서 다시 시도하세요)'); }
      const rec = await readRecord(engine, img, { onProgress: (text, frac) => emit('progress', { text, frac }) });
      if (!rec.valid) throw new Error('결과기록지로 인식되지 않았습니다 — 기록지 전체가 보이게 다시 찍어 주세요');
      if (!rec.count) throw new Error('측정값 행을 찾지 못했습니다');

      // 시험일: EXIF 촬영일(원본 파일에서) → 파일 수정일 → 공통 시험일 (아이폰 사파리는 lastModified 가 촬영일이 아닐 수 있다)
      let testDate = common.testDate;
      if (common.useFileDate) {
        testDate = (await exifPhotoDate(file)) || (file.lastModified ? todayStr(new Date(file.lastModified)) : common.testDate);
      }
      const doc = docFromRecord(rec, img, {
        testDate, pourDate: common.pourDate || '', site: common.site || '', tester: common.tester || '', supervisor: common.supervisor || '',
      });
      await db.putDoc(doc, await storedPhoto(img));
      saved.push({ name, doc, avgMatch: rec.avgMatch });
      emit('saved', { doc });
    } catch (e) {
      console.error(e);
      const message = e?.message || String(e);
      failed.push({ name, message });
      emit('failed', { message });
    }
    await tick();
  }
  return { saved, failed, aborted };
}
