// 아주 작은 PDF 작성기: 쪽마다 JPEG 이미지 한 장을 A4 가로 페이지에 넣는다 (의존성 없음).
// 양식은 이미지로 그려서 넣기 때문에 글꼴을 PDF 에 심을 필요가 없고 어느 PDF 뷰어에서든 똑같이 보인다.

const enc = new TextEncoder();

/** PDF 문자열: 영문/숫자는 (…) 로, 한글 등은 UTF-16BE 16진수로 */
function pdfText(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return `(${s.replace(/([\\()])/g, '\\$1')})`;
  let hex = 'FEFF';
  for (let i = 0; i < s.length; i++) hex += s.charCodeAt(i).toString(16).padStart(4, '0');
  return `<${hex.toUpperCase()}>`;
}

const pdfDate = (d) => `D:${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}${String(d.getUTCSeconds()).padStart(2, '0')}Z`;

/**
 * @param {{jpeg: Uint8Array, width: number, height: number, pageWidth?: number, pageHeight?: number, margin?: number}[]} pages
 *        픽셀 크기와 JPEG 바이트. 쪽마다 용지 크기/여백을 따로 줄 수 있다 (사진대지는 A4 세로, 여백 0)
 * @param {object} [o]
 * @param {string} [o.title]
 * @param {number} [o.pageWidth=841.89] 기본 용지: A4 가로 (pt)
 * @param {number} [o.pageHeight=595.28]
 * @param {number} [o.margin=22.68]     8mm
 * @returns {Uint8Array}
 */
export function buildPdf(pages, { title = '', pageWidth: defW = 841.89, pageHeight: defH = 595.28, margin: defM = 22.68 } = {}) {
  if (!pages.length) throw new Error('PDF 에 넣을 쪽이 없습니다');
  const chunks = [];
  let offset = 0;
  const offsets = [];
  const push = (data) => { const b = typeof data === 'string' ? enc.encode(data) : data; chunks.push(b); offset += b.length; };
  const begin = (n) => { offsets[n] = offset; push(`${n} 0 obj\n`); };

  push(new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]));   // %PDF-1.4 + 이진 표시

  const kids = pages.map((_, i) => `${4 + i * 3} 0 R`).join(' ');
  begin(1); push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  begin(2); push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>\nendobj\n`);
  begin(3); push(`<< /Title ${pdfText(title)} /Creator ${pdfText('Schmidt Hammer Datasheet')} /Producer ${pdfText('Schmidt Hammer Datasheet')} /CreationDate (${pdfDate(new Date())}) >>\nendobj\n`);

  pages.forEach((pg, i) => {
    const pageWidth = pg.pageWidth ?? defW, pageHeight = pg.pageHeight ?? defH, margin = pg.margin ?? defM;
    const boxW = pageWidth - margin * 2, boxH = pageHeight - margin * 2;
    const pageObj = 4 + i * 3, contentObj = 5 + i * 3, imageObj = 6 + i * 3;
    const scale = Math.min(boxW / pg.width, boxH / pg.height);
    const w = pg.width * scale, h = pg.height * scale;
    const x = (pageWidth - w) / 2, y = (pageHeight - h) / 2;
    const content = `q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /Im0 Do Q`;

    begin(pageObj);
    push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] /Resources << /XObject << /Im0 ${imageObj} 0 R >> /ProcSet [/PDF /ImageC] >> /Contents ${contentObj} 0 R >>\nendobj\n`);
    begin(contentObj);
    push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
    begin(imageObj);
    push(`<< /Type /XObject /Subtype /Image /Width ${pg.width} /Height ${pg.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${pg.jpeg.length} >>\nstream\n`);
    push(pg.jpeg);
    push('\nendstream\nendobj\n');
  });

  const count = 3 + pages.length * 3;
  const xref = offset;
  let table = `xref\n0 ${count + 1}\n0000000000 65535 f \n`;
  for (let n = 1; n <= count; n++) table += `${String(offsets[n]).padStart(10, '0')} 00000 n \n`;
  push(table);
  push(`trailer\n<< /Size ${count + 1} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(offset);
  let p = 0;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}
