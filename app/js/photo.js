// 문서함에 저장할 기록지 사진을 만든다: 디코딩된 이미지를 긴 변 2800px 이하의 JPEG 로 줄인다.
import { fitSize, PHOTO_MAX_SIDE } from './docs.js';
import { canvasToBlob } from './sheetimage.js';
import { bitmapFromBlob } from './ocr/loader.js';

/** @param img  decodeImage() 의 결과 { data(RGBA), width, height } (EXIF 회전이 이미 반영된, 회전하기 전의 사진) */
export async function storedPhoto(img, { max = PHOTO_MAX_SIDE, quality = 0.85 } = {}) {
  const src = document.createElement('canvas');
  src.width = img.width; src.height = img.height;
  src.getContext('2d').putImageData(new ImageData(img.data, img.width, img.height), 0, 0);
  const { width, height } = fitSize(img.width, img.height, max);
  let out = src;
  if (width !== img.width || height !== img.height) {
    out = document.createElement('canvas');
    out.width = width; out.height = height;
    const ctx = out.getContext('2d');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(src, 0, 0, width, height);
  }
  try {
    return await canvasToBlob(out, 'image/jpeg', quality);      // toBlob 은 안드로이드 WebView 에서 매번 4초 걸려 toDataURL 방식을 쓴다 (sheetimage.js 참고)
  } finally {
    src.width = src.height = 0;                                  // 큰 캔버스는 바로 비운다 (iOS Safari 는 캔버스 메모리 총량에 한도가 있다)
    out.width = out.height = 0;
  }
}

/**
 * 사진대지에 넣을 현장 사진: 이미지 파일 → 긴 변 1600px 이하 JPEG (EXIF 회전 반영).
 * 사진대지 사진 칸은 인쇄 크기가 12×9cm 정도라 1600px 이면 충분하다 (저장 공간을 아끼려고 더 키우지 않는다).
 * @returns {Promise<{blob: Blob, width: number, height: number}>}
 */
export async function shotImage(file, { max = 1600, quality = 0.85 } = {}) {
  const bmp = await bitmapFromBlob(file, { maxSide: max });   // EXIF 회전 보장: 브라우저가 안 돌려 줬으면 직접 돌린다 (loader.js)
  const { width, height } = fitSize(bmp.width, bmp.height, max);
  const c = document.createElement('canvas');
  c.width = width; c.height = height;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';                                // 투명 PNG 대비
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, width, height);
  bmp.close?.();
  try {
    return { blob: await canvasToBlob(c, 'image/jpeg', quality), width, height };
  } finally {
    c.width = c.height = 0;                              // 캔버스 메모리를 바로 돌려준다 (iOS Safari 캔버스 메모리 한도)
  }
}
