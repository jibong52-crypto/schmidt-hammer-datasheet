// 문서함 저장소 (IndexedDB). 문서(입력값)와 기록지 사진(Blob)을 따로 저장한다.
//
//  docs   : { id, ...문서 }                 — 작아서 목록을 통째로 읽어도 된다
//  photos : { id, buf, type }               — 문서와 같은 id. 사진은 크므로 필요할 때만 읽는다
//           (Safari 는 Blob 을 IndexedDB 에 넣다가 "Error preparing Blob/File data" 로 실패하는 일이 있어 ArrayBuffer 로 저장한다.
//            예전 버전이 저장한 { id, blob } 도 그대로 읽는다)
//
// IndexedDB 를 쓸 수 없는 환경(일부 시크릿 모드 등)에서는 메모리 저장소로 내려가고 persistent=false 가 된다.
// 이 경우 화면에서 "이번 접속 동안만 유지됩니다"라고 알린다.

const DB_NAME = 'schmidt-datasheet';
const DB_VERSION = 1;

let dbPromise = null;
const memory = { docs: new Map(), photos: new Map() };

export const status = { persistent: true, error: '' };

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      const fail = (e) => { status.persistent = false; status.error = String(e?.message || e || ''); resolve(null); };
      try {
        if (!('indexedDB' in window)) return fail(new Error('indexedDB 를 지원하지 않습니다'));
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
          if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' });
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => fail(req.error);
        req.onblocked = () => fail(new Error('다른 탭이 저장소를 사용 중입니다'));
      } catch (e) { fail(e); }
    });
  }
  return dbPromise;
}

const wrap = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
const done = (tx) => new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = (e) => reject(e?.target?.error || tx.error || new Error('저장 중 오류가 났습니다')); tx.onabort = () => reject(tx.error || new Error('저장이 중단되었습니다')); });

/** Blob → 저장용 레코드 (트랜잭션을 열기 전에 변환해 둔다: 트랜잭션은 await 사이에 닫힐 수 있다) */
const pack = async (id, blob) => ({ id, buf: await blob.arrayBuffer(), type: blob.type });
const unpack = (rec) => (!rec ? null : rec.blob instanceof Blob ? rec.blob : new Blob([rec.buf], { type: rec.type || 'image/jpeg' }));

export async function listDocs() {
  const db = await openDb();
  if (!db) return [...memory.docs.values()];
  return wrap(db.transaction('docs').objectStore('docs').getAll());
}

export async function getDoc(id) {
  const db = await openDb();
  if (!db) return memory.docs.get(id) || null;
  return (await wrap(db.transaction('docs').objectStore('docs').get(id))) || null;
}

/**
 * 문서를 저장한다.
 * @param photo  Blob → 사진을 저장/교체, null → 사진 삭제, undefined → 사진은 그대로 둔다
 */
export async function putDoc(doc, photo) {
  const db = await openDb();
  if (!db) {
    memory.docs.set(doc.id, doc);
    if (photo === null) memory.photos.delete(doc.id); else if (photo) memory.photos.set(doc.id, photo);
    return;
  }
  const rec = photo ? await pack(doc.id, photo) : null;
  const tx = db.transaction(['docs', 'photos'], 'readwrite');
  tx.objectStore('docs').put(doc);
  if (photo === null) tx.objectStore('photos').delete(doc.id);
  else if (rec) tx.objectStore('photos').put(rec);
  await done(tx);
}

/** 사진대지 사진은 같은 photos 저장소에 "문서id:사진id" 키로 넣는다 (문서 id 에는 ':' 가 없다) */
const shotKey = (docId, shotId) => `${docId}:${shotId}`;
const shotRange = (docId) => IDBKeyRange.bound(`${docId}:`, `${docId}:￿`);

export async function removeDocs(ids) {
  const db = await openDb();
  if (!db) {
    ids.forEach((id) => {
      memory.docs.delete(id); memory.photos.delete(id);
      for (const k of [...memory.photos.keys()]) if (k.startsWith(`${id}:`)) memory.photos.delete(k);
    });
    return;
  }
  const tx = db.transaction(['docs', 'photos'], 'readwrite');
  for (const id of ids) {
    tx.objectStore('docs').delete(id);
    tx.objectStore('photos').delete(id);
    tx.objectStore('photos').delete(shotRange(id));              // 사진대지 사진도 함께
  }
  await done(tx);
}

export async function putShot(docId, shotId, blob) {
  const db = await openDb();
  if (!db) { memory.photos.set(shotKey(docId, shotId), blob); return; }
  const rec = await pack(shotKey(docId, shotId), blob);
  const tx = db.transaction('photos', 'readwrite');
  tx.objectStore('photos').put(rec);
  await done(tx);
}

export async function getShot(docId, shotId) {
  const db = await openDb();
  if (!db) return memory.photos.get(shotKey(docId, shotId)) || null;
  return unpack(await wrap(db.transaction('photos').objectStore('photos').get(shotKey(docId, shotId))));
}

export async function removeShots(docId, shotIds) {
  if (!shotIds.length) return;
  const db = await openDb();
  if (!db) { shotIds.forEach((s) => memory.photos.delete(shotKey(docId, s))); return; }
  const tx = db.transaction('photos', 'readwrite');
  for (const s of shotIds) tx.objectStore('photos').delete(shotKey(docId, s));
  await done(tx);
}

export async function getPhoto(id) {
  const db = await openDb();
  if (!db) return memory.photos.get(id) || null;
  return unpack(await wrap(db.transaction('photos').objectStore('photos').get(id)));
}

/** 브라우저가 저장소를 임의로 지우지 않도록 요청한다 (거절돼도 동작에는 문제 없다) */
export async function requestPersistence() {
  try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
}
