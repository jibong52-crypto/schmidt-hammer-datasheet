// 양식(.page 요소)을 이미지(canvas → JPEG)로 그린다. PDF 와 ZIP 내보내기에서 쓴다.
//
// 화면에 보이는 양식과 똑같이 나오도록 별도의 그리기 코드를 만들지 않고, 같은 HTML/CSS 를 SVG foreignObject 에 담아
// 이미지로 읽어 들인 뒤 canvas 에 그린다 (브라우저/WebView 의 글꼴·레이아웃을 그대로 쓴다).
// 외부 파일을 읽을 수 없는 이미지 문서 안에서 그려지므로 CSS 는 통째로 포함하고, 보정 그래프는 data URL 로 바꿔 넣는다.

export const PAGE_W = 1342;      // 양식의 설계 크기(px) — css/app.css 의 .page 와 같다
export const PAGE_H = 926;
const DEFAULT_W = PAGE_W, DEFAULT_H = PAGE_H;

// 2쪽의 보정 그래프(img.chart) 위치 — css/app.css 의 .chart 와 같아야 한다.
// 그래프는 SVG 안에 넣지 않고 canvas 에 직접 그린다: 큰 PNG 를 data URL 로 SVG 에 넣으면 폰(안드로이드 WebView)에서 JPEG 로 뽑는 데만 13초가 걸렸다.
const CHART_BOX = { left: 716, top: 22, width: 610 };

let cssText = null;
let chartBitmap = null;

const here = (rel) => new URL(rel, import.meta.url);

async function loadCss() {
  if (cssText === null) {
    const res = await fetch(here('../css/app.css'));
    if (!res.ok) throw new Error('스타일시트를 읽지 못했습니다');
    cssText = await res.text();
  }
  return cssText;
}

/** 보정 그래프를 한 번만 디코딩해 두고 모든 문서에 다시 쓴다 */
async function loadChart() {
  if (chartBitmap === null) {
    const res = await fetch(here('../assets/chart-direction.png'));
    if (!res.ok) throw new Error('보정 그래프를 읽지 못했습니다');
    chartBitmap = await createImageBitmap(await res.blob());
  }
  return chartBitmap;
}

/**
 * @param {Element} pageEl  #page1 / #page2 / 사진대지 쪽 (값이 이미 채워진 상태)
 * @param {number} scale    출력 배율 (1 = 설계 크기. 가로 양식 1342×926px 에서 1.75 ≈ A4 가로 150dpi)
 * @param {object} [o]
 * @param {number} [o.width]   쪽의 설계 너비 (기본: 가로 양식 1342) — 사진대지는 794
 * @param {number} [o.height]  쪽의 설계 높이 (기본 926) — 사진대지는 1123
 * @param {(ctx:CanvasRenderingContext2D, scale:number)=>void} [o.after]  양식을 그린 뒤 위에 더 그릴 것 (사진 등)
 * @returns {Promise<HTMLCanvasElement>}
 */
export async function pageToCanvas(pageEl, scale = 1.5, { width: PAGE_W = DEFAULT_W, height: PAGE_H = DEFAULT_H, after } = {}) {
  const clone = pageEl.cloneNode(true);
  clone.removeAttribute('id');
  clone.querySelectorAll('img.ph-shot').forEach((img) => img.remove());         // 사진대지 사진은 after 에서 캔버스에 직접 그린다
  clone.setAttribute('style', `position:relative;transform:none;width:${PAGE_W}px;height:${PAGE_H}px;`);   // 화면용 축소(--k)를 걷어낸다
  const hasChart = !!clone.querySelector('img.chart');
  clone.querySelectorAll('img.chart').forEach((img) => img.remove());          // 그래프는 아래에서 canvas 에 직접 그린다
  const [css, chart] = await Promise.all([loadCss(), hasChart ? loadChart() : null]);
  clone.querySelectorAll('#gridSvg text.i').forEach((t) => t.remove());     // 화면에서만 보이는 타점 번호(01~20)는 인쇄물과 같이 뺀다
  const body = new XMLSerializer().serializeToString(clone);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${PAGE_W}" height="${PAGE_H}" viewBox="0 0 ${PAGE_W} ${PAGE_H}">` +
    `<foreignObject x="0" y="0" width="${PAGE_W}" height="${PAGE_H}">` +
    `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${PAGE_W}px;height:${PAGE_H}px;background:#fff">` +
    `<style><![CDATA[${css}]]></style>${body}</div></foreignObject></svg>`;

  // ※ Blob URL 로 읽으면 foreignObject 가 든 SVG 가 canvas 를 오염(tainted)시켜 이미지로 뽑을 수 없다.
  //    data: URL 은 오염시키지 않는다 (Chromium/WebView).
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  const img = new Image();
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('양식을 이미지로 바꾸지 못했습니다'));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(PAGE_W * scale);
  canvas.height = Math.round(PAGE_H * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  if (chart) {
    ctx.imageSmoothingQuality = 'high';
    const w = CHART_BOX.width, h = (w * chart.height) / chart.width;
    ctx.drawImage(chart, CHART_BOX.left * scale, CHART_BOX.top * scale, w * scale, h * scale);
  }
  if (after) after(ctx, scale);
  return canvas;
}

/**
 * canvas → JPEG/PNG Blob.
 * canvas.toBlob() 은 쓰지 않는다: 안드로이드 WebView 에서는 "브라우저가 한가해질 때"까지 기다리다 4초 뒤에야 인코딩해서
 * 호출할 때마다 정확히 4초가 걸렸다(폰에서 실측: toBlob 4072ms, toDataURL 22~52ms). 바로 인코딩하는 toDataURL 을 쓴다.
 */
export function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.92) {
  try {
    const url = canvas.toDataURL(type, quality);
    if (!url.startsWith(`data:${type}`)) throw new Error(`${type} 형식으로 저장할 수 없습니다`);
    const bin = atob(url.slice(url.indexOf(',') + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return Promise.resolve(new Blob([bytes], { type }));
  } catch (e) {
    return Promise.reject(e instanceof Error ? e : new Error('이미지를 만들지 못했습니다'));
  }
}
