// 문서함 화면: 시험일별 목록, 검색, 여러 건 선택 → ZIP 내보내기/삭제, 사진 여러 장 한꺼번에 추가, ZIP 가져오기.
import * as db from './store.js';
import { groupByDate, matches, summaryOf, statusFlags, titleOf, subtitleOf, weekdayKo, todayStr } from './docs.js';
import { buildBundle, importBundle } from './bundle.js';
import { importPhotos } from './batch.js';
import { h, toast, dialog, confirmDialog, progressDialog, deliverFile, onBack } from './ui.js';

const $ = (id) => document.getElementById(id);
const PREF_KEY = 'schmidt.export.v1';
const IMAGE_RE = /\.(jpe?g|png|webp|bmp|gif|heic|heif)$/i;
const isImage = (f) => (f.type ? f.type.startsWith('image/') : IMAGE_RE.test(f.name || ''));
const isArchive = (f) => /\.(zip|json)$/i.test(f.name || '') || /zip|json/.test(f.type || '');

function loadPref() {
  try { return { pdf: true, photos: true, ...JSON.parse(localStorage.getItem(PREF_KEY) || '{}') }; } catch { return { pdf: true, photos: true }; }
}
function savePref(p) { try { localStorage.setItem(PREF_KEY, JSON.stringify(p)); } catch { /* 저장소가 막힌 환경 */ } }

/**
 * @param {object} o
 * @param {(id:string)=>Promise<void>} o.openDoc        문서를 작성 화면에서 연다
 * @param {()=>Promise<object>} o.ensureEngine          OCR 엔진
 * @param {()=>{site:string,tester:string,supervisor:string}} o.getDefaults   사진 추가 대화상자의 기본값
 * @param {(c:object)=>void} [o.rememberProfile]        사진 추가에 쓴 현장명·시험자·감리원을 기억 목록에 올린다
 * @param {(ids:string[])=>void} [o.onDeleted]
 * @param {(count:number)=>void} [o.onCount]
 */
export function initLibrary({ openDoc, ensureEngine, getDefaults, rememberProfile, onDeleted, onCount }) {
  let docs = [];
  let query = '';
  const selected = new Set();
  let busy = false;

  /* ───────── 목록 ───────── */

  async function refresh() {
    docs = await db.listDocs();
    const ids = new Set(docs.map((d) => d.id));
    for (const id of [...selected]) if (!ids.has(id)) selected.delete(id);
    onCount?.(docs.length);
    $('libStorageNote').hidden = db.status.persistent;
    render();
  }

  function flagEl(f) { return h('span', { class: `flag ${f.kind}`, text: f.text }); }

  function docEl(d) {
    const s = summaryOf(d);
    const fc = s.calc.retest ? h('b', { class: 'bad', text: '재시험' })
      : s.Fc !== null ? [h('b', { text: s.Fc.toFixed(1) }), h('i', { text: 'MPa' })]
        : h('b', { class: 'none', text: '–' });
    const flags = s.flags.filter((f) => f.text !== '재시험');
    return h('li', { class: 'doc', dataset: { id: d.id } },
      h('label', { class: 'pick' },
        h('input', { type: 'checkbox', 'aria-label': `${titleOf(d)} 선택`, onChange: (e) => { toggle([d.id], e.target.checked); } })),
      h('button', { type: 'button', class: 'doc-main', onClick: () => openDoc(d.id) },
        h('span', { class: 'doc-title', text: titleOf(d) }),
        h('span', { class: 'doc-sub', text: subtitleOf(d) }),
        h('span', { class: 'doc-meta' },
          s.R0 !== null && h('span', { class: 'r0', text: `R₀ ${s.R0.toFixed(1)}` }),
          d.photo && h('span', { class: 'photo', text: '사진' }),
          d.shots?.length > 0 && h('span', { class: 'photo', text: `사진대지 ${d.shots.length}장` }),
          flags.map(flagEl))),
      h('div', { class: 'doc-fc' }, fc));
  }

  function dayEl(g) {
    const ids = g.docs.map((d) => d.id);
    const wk = weekdayKo(g.date);
    return h('section', { class: 'day', dataset: { date: g.date, ids: ids.join(',') } },
      h('header', { class: 'day-head' },
        h('label', { class: 'pick' }, h('input', { type: 'checkbox', 'aria-label': `${g.date || '시험일 없음'} 전체 선택`, onChange: (e) => toggle(ids, e.target.checked) })),
        h('h3', {}, g.date || '시험일 없음', wk && h('span', { class: 'wk', text: ` (${wk})` })),
        h('span', { class: 'day-count', text: `${g.docs.length}건` }),
        h('button', { type: 'button', class: 'btn small', text: '이 날짜 내보내기', onClick: () => exportDocs(g.docs) })),
      h('ul', { class: 'docs' }, g.docs.map(docEl)));
  }

  function render() {
    const shown = docs.filter((d) => matches(d, query));
    const list = $('libList');
    list.textContent = '';
    for (const g of groupByDate(shown)) list.append(dayEl(g));
    $('libCount').textContent = docs.length ? (shown.length === docs.length ? `${docs.length}건` : `${shown.length} / ${docs.length}건`) : '';
    $('libEmpty').hidden = docs.length > 0;
    $('libNoMatch').hidden = !(docs.length && !shown.length);
    $('libFilter').hidden = docs.length === 0;
    syncSelection();
  }

  /** 선택 상태를 화면에 반영 (목록을 다시 그리지 않아서 키보드 포커스와 스크롤이 그대로 유지된다) */
  function syncSelection() {
    const list = $('libList');
    list.querySelectorAll('.doc').forEach((li) => {
      const on = selected.has(li.dataset.id);
      li.classList.toggle('picked', on);
      li.querySelector('input').checked = on;
    });
    list.querySelectorAll('.day').forEach((sec) => {
      const ids = sec.dataset.ids.split(',');
      const n = ids.filter((id) => selected.has(id)).length;
      const cb = sec.querySelector('.day-head input');
      cb.checked = n === ids.length && n > 0;
      cb.indeterminate = n > 0 && n < ids.length;
    });
    const n = selected.size;
    $('selBar').hidden = n === 0;
    $('selCount').textContent = `${n}건 선택`;
    const shown = docs.filter((d) => matches(d, query));
    $('libSelectAll').textContent = shown.length && shown.every((d) => selected.has(d.id)) ? '선택 해제' : '전체 선택';
  }

  function toggle(ids, on) {
    ids.forEach((id) => (on ? selected.add(id) : selected.delete(id)));
    syncSelection();
  }

  const selectedDocs = () => docs.filter((d) => selected.has(d.id));

  /* ───────── 내보내기 (ZIP) ───────── */

  async function exportDocs(list) {
    if (!list.length || busy) return;
    const pref = loadPref();
    const withPhoto = list.reduce((n, d) => n + (d.photo ? 1 : 0) + (d.shots?.length || 0), 0);       // 결과기록지 사진 + 사진대지 사진
    const dates = [...new Set(list.map((d) => d.testDate).filter(Boolean))].sort();
    const cbPdf = h('input', { type: 'checkbox' });
    const cbPhoto = h('input', { type: 'checkbox' });
    cbPdf.checked = !!pref.pdf;
    cbPhoto.checked = !!pref.photos && withPhoto > 0;
    cbPhoto.disabled = withPhoto === 0;
    const opt = (cb, title, note) => h('label', { class: 'opt' }, cb, h('span', {}, h('b', { text: title }), h('small', { text: note })));
    const d = dialog({
      title: `${list.length}건을 ZIP으로 내보내기`,
      body: [
        h('p', { class: 'dlg-text', text: `${dates.length ? `시험일 ${dates[0]}${dates.length > 1 ? ` ~ ${dates[dates.length - 1]}` : ''} · ` : ''}날짜별 폴더로 정리됩니다.` }),
        opt(cbPdf, '양식 PDF', '문서마다 데이터시트·참고표 2쪽(A4 가로) + 사진대지(A4 세로)'),
        opt(cbPhoto, '사진 (결과기록지·사진대지)', withPhoto ? `${withPhoto}장 (용량이 커집니다)` : '사진이 있는 문서가 없습니다'),
        h('p', { class: 'hint', text: '엑셀용 목록.csv 와 이 앱으로 다시 가져올 수 있는 데이터.json 은 항상 들어갑니다.' }),
      ],
      actions: [{ label: '취소', value: false }, { label: '내보내기', value: true, kind: 'primary' }],
    });
    if (!(await d.result)) return;
    const opts = { pdf: cbPdf.checked, photos: cbPhoto.checked };
    savePref(opts);

    busy = true;
    const ac = new AbortController();
    const pd = progressDialog({ title: 'ZIP 만드는 중', onCancel: () => ac.abort() });
    try {
      const out = await buildBundle(list, {
        ...opts, signal: ac.signal,
        onProgress: (done, total, label) => pd.update(total ? done / total : 1, `${Math.min(done + 1, total)} / ${total}`, label),
      });
      pd.close();
      busy = false;
      await deliverFile(out.blob, out.name, 'application/zip');
    } catch (e) {
      pd.close();
      if (e?.name === 'AbortError') toast('내보내기를 중단했습니다');
      else { console.error(e); toast(`내보내지 못했습니다: ${e?.message || e}`, 'bad', 7000); }
    } finally {
      busy = false;
    }
  }

  /* ───────── 삭제 ───────── */

  async function deleteSelected() {
    const list = selectedDocs();
    if (!list.length) return;
    const ok = await confirmDialog({
      title: `${list.length}건 삭제`,
      message: `선택한 문서 ${list.length}건과 저장된 기록지 사진을 삭제합니다.\n되돌릴 수 없습니다. 보관이 필요하면 먼저 ZIP으로 내보내세요.`,
      ok: '삭제', danger: true,
    });
    if (!ok) return;
    const ids = list.map((d) => d.id);
    try {
      await db.removeDocs(ids);
    } catch (e) {
      toast(`삭제하지 못했습니다: ${e?.message || e}`, 'bad', 6000);
      return;
    }
    selected.clear();
    onDeleted?.(ids);
    await refresh();
    toast(`${ids.length}건을 삭제했습니다`, 'ok');
  }

  /* ───────── 사진 여러 장 추가 ───────── */

  async function askBatchSettings(count) {
    const def = getDefaults?.() || {};
    const inDate = h('input', { type: 'date', value: todayStr() });
    const inFileDate = h('input', { type: 'checkbox' });
    const inPour = h('input', { type: 'date' });
    const inSite = h('input', { type: 'text', value: def.site || '', maxlength: 60, autocomplete: 'off' });
    const inTester = h('input', { type: 'text', value: def.tester || '', maxlength: 40, autocomplete: 'off' });
    const inSup = h('input', { type: 'text', value: def.supervisor || '', maxlength: 40, autocomplete: 'off' });
    const err = h('p', { class: 'dlg-error', role: 'alert', hidden: true });
    inFileDate.addEventListener('change', () => { inDate.disabled = inFileDate.checked; });
    const d = dialog({
      title: `사진 ${count}장을 문서로 저장`,
      wide: true,
      body: [
        h('p', { class: 'dlg-text', text: '사진을 한 장씩 읽어 문서로 저장합니다 (한 장에 보통 몇 초). 아래 값은 모든 문서에 똑같이 들어가고, 시험위치는 나중에 문서를 열어 적으면 됩니다.' }),
        h('div', { class: 'fields' },
          h('label', {}, '시험일', inDate),
          h('label', {}, h('span', { class: 'auto', text: ' ' }), h('span', { class: 'inline-check' }, inFileDate, '사진 파일의 날짜 사용')),
          h('label', { class: 'wide' }, '현장명', inSite),
          h('label', {}, '시험자', inTester),
          h('label', {}, '감리원', inSup),
          h('label', {}, '타설일 (선택)', inPour)),
        err,
      ],
      actions: [
        { label: '취소', value: null },
        {
          label: '시작', kind: 'primary',
          onClick: () => {
            if (!inFileDate.checked && !inDate.value) { err.textContent = '시험일을 입력하거나 [사진 파일의 날짜 사용]을 선택하세요.'; err.hidden = false; return false; }
            return true;
          },
          value: 'go',
        },
      ],
    });
    if ((await d.result) !== 'go') return null;
    return {
      testDate: inDate.value, useFileDate: inFileDate.checked, pourDate: inPour.value,
      site: inSite.value.trim(), tester: inTester.value.trim(), supervisor: inSup.value.trim(),
    };
  }

  async function startBatch(fileList) {
    const files = [...fileList].filter(isImage);
    if (!files.length) { toast('이미지 파일(JPG/PNG)을 선택하세요', 'bad'); return; }
    if (busy) { toast('다른 작업이 진행 중입니다'); return; }
    const common = await askBatchSettings(files.length);
    if (!common) return;
    rememberProfile?.(common);

    busy = true;
    const ac = new AbortController();
    const pd = progressDialog({ title: `사진 ${files.length}장 읽는 중`, onCancel: () => ac.abort(), cancelLabel: '여기서 멈추기' });
    pd.update(0, '문자 인식 엔진을 준비하는 중…', '처음 한 번은 조금 걸립니다');
    let result;
    try {
      result = await importPhotos(files, common, {
        ensureEngine, signal: ac.signal,
        onItem: (ev) => {
          const base = ev.index / ev.total;
          if (ev.phase === 'start') pd.update(base, `${ev.index + 1} / ${ev.total}  ${ev.name}`, '읽는 중…');
          else if (ev.phase === 'progress') pd.update(base + (ev.frac || 0) / ev.total * 0.95, `${ev.index + 1} / ${ev.total}  ${ev.name}`, ev.text || '');
          else pd.update((ev.index + 1) / ev.total, `${ev.index + 1} / ${ev.total}  ${ev.name}`, ev.phase === 'saved' ? '저장했습니다' : '건너뜀');
        },
      });
    } catch (e) {
      console.error(e);
      pd.close();
      busy = false;
      toast(`사진을 처리하지 못했습니다: ${e?.message || e}`, 'bad', 7000);
      await refresh();
      return;
    }
    pd.close();
    busy = false;
    await refresh();
    await showBatchResult(files.length, result);
  }

  async function showBatchResult(total, { saved, failed, aborted }) {
    const rows = [
      ...saved.map(({ name, doc }) => {
        const flags = statusFlags(doc);
        return h('li', { class: 'res' },
          h('span', { class: 'res-name', text: name }),
          flags.length ? flags.map(flagEl) : h('span', { class: 'flag ok', text: '정상' }));
      }),
      ...failed.map(({ name, message }) => h('li', { class: 'res fail' },
        h('span', { class: 'res-name', text: name }), h('span', { class: 'res-msg', text: message }))),
    ];
    const head = `${total}장 중 ${saved.length}건을 문서함에 저장했습니다.` +
      (failed.length ? ` ${failed.length}장은 건너뛰었습니다.` : '') +
      (aborted ? ` (${total - saved.length - failed.length}장은 처리하지 않고 멈췄습니다)` : '');
    const d = dialog({
      title: '사진 추가 결과', wide: true,
      body: [h('p', { class: 'dlg-text', text: head }), saved.length ? h('p', { class: 'hint', text: '[확인 필요] 표시가 있는 문서는 열어서 기록지와 대조해 보세요.' }) : null, h('ul', { class: 'results' }, rows)],
      actions: [{ label: '닫기', value: 'close' }, ...(saved.length ? [{ label: '문서함에서 보기', value: 'docs', kind: 'primary' }] : [])],
    });
    if ((await d.result) === 'docs' && !location.hash.startsWith('#/docs')) location.hash = '#/docs';
  }

  /* ───────── ZIP 가져오기 ───────── */

  async function importFile(file) {
    if (busy) { toast('다른 작업이 진행 중입니다'); return; }
    busy = true;
    const pd = progressDialog({ title: '가져오는 중' });
    pd.update(0, file.name);
    try {
      const r = await importBundle(file, { onProgress: (i, n) => pd.update(n ? i / n : 1, file.name, n ? `${i} / ${n}건` : '') });
      pd.close();
      busy = false;
      await refresh();
      const parts = [`새 문서 ${r.added}건`];
      if (r.updated) parts.push(`갱신 ${r.updated}건`);
      if (r.skipped) parts.push(`이미 최신이라 건너뜀 ${r.skipped}건`);
      if (r.invalid) parts.push(`읽을 수 없음 ${r.invalid}건`);
      toast(`가져왔습니다: ${parts.join(', ')}`, r.added || r.updated ? 'ok' : '', 6000);
    } catch (e) {
      console.error(e);
      pd.close();
      busy = false;
      toast(`가져오지 못했습니다: ${e?.message || e}`, 'bad', 7000);
    }
  }

  /** 끌어다 놓은/선택한 파일을 종류에 따라 처리 (ZIP·JSON → 가져오기, 이미지 → 여러 장 추가) */
  async function handleFiles(fileList) {
    const files = [...fileList];
    const archive = files.find(isArchive);
    if (archive) return importFile(archive);
    return startBatch(files);
  }

  /* ───────── 이벤트 ───────── */

  $('libSearch').addEventListener('input', (e) => { query = e.target.value; render(); });
  $('libSearch').addEventListener('keydown', (e) => { if (e.key === 'Escape' && e.target.value) { e.target.value = ''; query = ''; render(); } });
  $('libSelectAll').addEventListener('click', () => {
    const shown = docs.filter((d) => matches(d, query));
    const all = shown.length && shown.every((d) => selected.has(d.id));
    toggle(shown.map((d) => d.id), !all);
  });
  $('libBatch').addEventListener('click', () => $('libPhotoInput').click());
  $('libImport').addEventListener('click', () => $('libImportInput').click());
  $('libPhotoInput').addEventListener('change', (e) => { const f = [...e.target.files]; e.target.value = ''; if (f.length) startBatch(f); });
  $('libImportInput').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importFile(f); });
  $('selExport').addEventListener('click', () => exportDocs(selectedDocs()));
  $('selDelete').addEventListener('click', deleteSelected);
  $('selClear').addEventListener('click', () => { selected.clear(); syncSelection(); });
  onBack(() => {
    if (document.getElementById('viewLibrary').hidden || !selected.size) return false;
    selected.clear(); syncSelection();
    return true;
  });

  return { refresh, startBatch, handleFiles, count: () => docs.length };
}
