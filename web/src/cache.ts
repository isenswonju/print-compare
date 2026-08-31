// 브라우저 캐시 (IndexedDB) — 전자동, 관리 불필요.
//  * refWords: 아트웍(REF) 파일 해시 → OCR 단어 목록. 같은 아트웍 재검수 시
//    REF OCR(~90초)을 통째로 건너뛴다. 아트웍이 개정되면 해시가 달라져
//    자동으로 새로 계산된다.
//  * artworks: 공용 보관함의 로컬 사본. 서버가 원본이고 로컬은 캐시다 —
//    목록(메타데이터)은 전부 두되, 파일 본체(blob)는 서버에서 필요할 때
//    내려받고 저장 공간이 부족해지면 오래 안 쓴 것부터 비운다(pruneBlobCache).
//  * session: 마지막 검수 결과(키 "last")와 삭제 기록(키 "tombstones").
//    공용 보관함에서 "지웠다"는 사실도 기기 간에 전파돼야 해서, 삭제 시각을
//    남겨 매니페스트에 실어 보낸다.
import type { PipelineResult, SetFb, Word } from "./types.ts";

const DB_NAME = "artwork-compare-cache";
// 필요한 오브젝트 스토어. **버전 번호로 스키마를 올리지 않는다** — 아래 openDB 주석 참고.
const STORES = ["refWords", "artworks", "session", "sections"] as const;
// 삭제 기록은 새 스토어를 만들지 않으려고 session 스토어의 이 키에 통째로 둔다
// (session은 "last" 키만 쓰던 범용 키-값 스토어라 충돌하지 않는다).
const TOMB_KEY = "tombstones";
// 결과 세션 보존 정책 (일반적인 웹 도구 관례): 최근 1세션만, 7일 후 만료.
// 브라우저 안에만 저장되며 서버로 가지 않는다.
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// OCR 설정이 바뀌면 키가 달라져 옛 캐시를 자연 무효화한다
export const OCR_CACHE_VER = "v1-eng-best-psm3";

export interface ArtworkEntry {
  hash: string;
  name: string;
  size: number;
  type: string;
  // 파일 본체. 서버에서 목록만 받아온 항목은 blob 없이 url만 갖고 있다가
  // 실제로 쓸 때(검수 투입 등) 내려받아 채운다.
  blob?: Blob;
  url?: string;      // 서버 blob URL(내용 주소) — 필요 시 내려받기용
  lastUsed: number;
  section?: string;  // 소속 섹션 id(없으면 미분류)
  updatedAt?: number; // 마지막 변경 시각 — 삭제 기록(tombstone)과 승부용
}

export interface Section {
  id: string;
  name: string;
  createdAt: number;
  parentId?: string; // 상위 섹션 id(없으면 최상위). 중첩 폴더 지원.
  updatedAt?: number; // 마지막 변경 시각 — 삭제 기록과 승부용
}

let dbPromise: Promise<IDBDatabase> | null = null;

// 버전 번호를 올려 스키마를 바꾸지 않는다. IndexedDB는 버전이 올라가면
// **다른 탭이 옛 버전으로 열어둔 연결이 전부 닫힐 때까지** 업그레이드를
// 시작하지 않는데, 이 앱은 여러 탭에 띄워두고 쓰는 도구라 그 조건이 늘 깨진다.
// 실제로 v3→v4(스토어 추가)에서 open이 성공도 실패도 blocked도 없이 영원히
// 매달려 보관함이 통째로 멈췄다. 그래서
//  · 버전 없이 연다 — 업그레이드를 유발하지 않으니 막힐 일이 없다.
//  · 스토어가 실제로 없을 때만(신규 브라우저) 버전+1로 다시 열어 만든다.
//    이 경로는 DB가 비어 있을 때뿐이라 붙들고 있는 다른 탭이 없다.
// 새 데이터를 넣고 싶으면 스토어를 늘리지 말고 기존 스토어의 키를 쓴다
// (삭제 기록을 session/TOMB_KEY에 두는 이유다).
function rawOpen(version?: number): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const req = version === undefined
      ? indexedDB.open(DB_NAME) : indexedDB.open(DB_NAME, version);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES)
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
    };
    req.onblocked = () => rej(new Error(
      "이 앱이 열려 있는 다른 탭·창 때문에 보관함을 열지 못했습니다 — " +
      "다른 탭을 모두 닫고 새로고침해주세요."));
    req.onsuccess = () => {
      const db = req.result;
      // 다른 탭이 업그레이드를 원하면 내 연결을 놓아준다(내가 막지 않도록).
      db.onversionchange = () => { db.close(); dbPromise = null; };
      res(db);
    };
    req.onerror = () => rej(req.error);
  });
}

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const p = (async () => {
    let db = await rawOpen();
    if (STORES.some((s) => !db.objectStoreNames.contains(s))) {
      const next = db.version + 1;
      db.close();
      db = await rawOpen(next);
    }
    return db;
  })();
  // 실패를 캐시하면 새로고침 전까지 영구 실패한다 — 다음 호출이 다시 시도하게.
  p.catch(() => { if (dbPromise === p) dbPromise = null; });
  dbPromise = p;
  return p;
}

function tx<T>(store: string, mode: IDBTransactionMode,
               fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T | undefined> {
  return openDB().then((db) =>
    new Promise<T | undefined>((res, rej) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      const out = fn(s);
      t.oncomplete = () =>
        res(out && out.result !== undefined ? (out.result as T) : undefined);
      t.onerror = () => rej(t.error);
    }));
}

// FNV-1a 폴백 — crypto.subtle은 보안 컨텍스트(HTTPS/localhost)에서만 존재한다.
// 사내망 http:// 접속에서는 이 폴백을 쓴다. 캐시 키 용도로는 충분하다.
function fnvHash(bytes: Uint8Array, seed: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

export async function hashFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  if (crypto?.subtle) {
    const digest = await crypto.subtle.digest("SHA-256", buf);
    return [...new Uint8Array(digest)]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  const bytes = new Uint8Array(buf);
  return `fnv-${bytes.length.toString(16)}-` +
         fnvHash(bytes, 0x811c9dc5) + fnvHash(bytes, 0x01000193);
}

export const getRefWords = (hash: string) =>
  tx<{ words: Word[]; ts: number }>("refWords", "readonly",
    (s) => s.get(`${hash}|${OCR_CACHE_VER}`))
    .catch(() => undefined);

export const putRefWords = (hash: string, words: Word[]) =>
  tx("refWords", "readwrite", (s) =>
    s.put({ words, ts: Date.now() }, `${hash}|${OCR_CACHE_VER}`))
    .catch(() => {});

// -------------------------------------------------- 삭제 기록(tombstone)
// 공용 보관함은 "없다"와 "지웠다"를 구분해야 한다 — 그냥 지우기만 하면 다음
// 동기화에서 서버 매니페스트가 도로 살려낸다. 삭제 시각을 남겨 매니페스트에
// 실어 보내고, 병합 때 삭제 이후에 다시 추가된 항목만 살아남는다.
export type Tombstones = {
  artworks: Record<string, number>;  // hash → 삭제 시각(epoch ms)
  sections: Record<string, number>;  // id → 삭제 시각
};

export async function listTombstones(): Promise<Tombstones> {
  try {
    const rec = await tx<Tombstones>("session", "readonly",
      (s) => s.get(TOMB_KEY));
    return { artworks: rec?.artworks ?? {}, sections: rec?.sections ?? {} };
  } catch { return { artworks: {}, sections: {} }; }
}

// 기록 1건 추가/삭제 — 맵 하나를 통째로 읽고 쓴다(항목 수가 적어 충분하다).
async function editTombstones(
  fn: (t: Tombstones) => void): Promise<void> {
  try {
    const t = await listTombstones();
    fn(t);
    await tx("session", "readwrite", (s) => s.put(t, TOMB_KEY));
  } catch { /* 무시 */ }
}

const putTombstone = (kind: "artworks" | "sections", id: string) =>
  editTombstones((t) => { t[kind][id] = Date.now(); });
const dropTombstone = (kind: "artworks" | "sections", id: string) =>
  editTombstones((t) => { delete t[kind][id]; });

// 동기화 반영 후 필요 없어진 기록 정리(병합 결과에 반영된 것만 남긴다).
export async function replaceTombstones(t: Tombstones): Promise<void> {
  try {
    await tx("session", "readwrite", (s) => s.put(
      { artworks: t.artworks ?? {}, sections: t.sections ?? {} }, TOMB_KEY));
  } catch { /* 무시 */ }
}

// 재저장 시 기존 폴더 배정은 유지한다(section 인자는 신규 저장일 때만 쓰인다 —
// 보관함으로 직접 드롭한 파일을 그 폴더에 바로 넣기 위한 것).
// 다시 추가하면 삭제 기록을 지워 동기화에서 되살아나게 한다.
export async function saveArtwork(
  hash: string, file: File, section?: string): Promise<void> {
  try {
    const existing = await tx<Omit<ArtworkEntry, "hash">>(
      "artworks", "readonly", (s) => s.get(hash));
    await tx("artworks", "readwrite", (s) =>
      s.put({ name: file.name, size: file.size, type: file.type,
              blob: file, lastUsed: Date.now(), updatedAt: Date.now(),
              url: existing?.url,
              section: existing ? existing.section : section }, hash));
    await dropTombstone("artworks", hash);
  } catch { /* 캐시 실패는 기능에 영향 없음 */ }
}

export async function deleteArtwork(hash: string): Promise<void> {
  try {
    await tx("artworks", "readwrite", (s) => s.delete(hash));
    await putTombstone("artworks", hash);
  } catch { /* 무시 */ }
}

export async function setArtworkSection(
  hash: string, section: string | undefined): Promise<void> {
  try {
    const rec = await tx<Omit<ArtworkEntry, "hash">>(
      "artworks", "readonly", (s) => s.get(hash));
    if (!rec) return;
    await tx("artworks", "readwrite", (s) =>
      s.put({ ...rec, section, updatedAt: Date.now() }, hash));
  } catch { /* 무시 */ }
}

// 이름(가나다·ABC) 오름차순 정렬로 반환.
export async function listArtworks(): Promise<ArtworkEntry[]> {
  try {
    const db = await openDB();
    return await new Promise((res, rej) => {
      const t = db.transaction("artworks", "readonly");
      const s = t.objectStore("artworks");
      const out: ArtworkEntry[] = [];
      const cur = s.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) {
          out.push({ hash: String(c.key), ...(c.value as Omit<ArtworkEntry, "hash">) });
          c.continue();
        } else res(out.sort((a, b) => a.name.localeCompare(b.name, "ko")));
      };
      cur.onerror = () => rej(cur.error);
    });
  } catch { return []; }
}

// -------------------------------------------------------------- 섹션(폴더)
// 보관함을 사용자가 정리할 수 있게 하는 섹션. 생성 순으로 나열.
let sectionSeq = 0;

export async function listSections(): Promise<Section[]> {
  try {
    const db = await openDB();
    return await new Promise((res, rej) => {
      const t = db.transaction("sections", "readonly");
      const s = t.objectStore("sections");
      const out: Section[] = [];
      const cur = s.openCursor();
      cur.onsuccess = () => {
        const c = cur.result;
        if (c) { out.push(c.value as Section); c.continue(); }
        else res(out.sort((a, b) => a.createdAt - b.createdAt));
      };
      cur.onerror = () => rej(cur.error);
    });
  } catch { return []; }
}

export async function createSection(
  name: string, parentId?: string): Promise<Section | null> {
  try {
    const sec: Section = {
      id: `sec-${Date.now().toString(36)}-${++sectionSeq}`,
      name, createdAt: Date.now(), parentId, updatedAt: Date.now(),
    };
    await tx("sections", "readwrite", (s) => s.put(sec, sec.id));
    return sec;
  } catch { return null; }
}

export async function renameSection(id: string, name: string): Promise<void> {
  try {
    const rec = await tx<Section>("sections", "readonly", (s) => s.get(id));
    if (!rec) return;
    await tx("sections", "readwrite", (s) =>
      s.put({ ...rec, name, updatedAt: Date.now() }, id));
  } catch { /* 무시 */ }
}

// 폴더를 다른 폴더 아래로 옮긴다(parentId 없으면 최상위로). 자기 자신이나
// 자기 하위로는 옮길 수 없다 — 트리가 끊어져 폴더가 통째로 사라져 보인다.
export async function moveSection(
  id: string, parentId?: string): Promise<boolean> {
  try {
    const secs = await listSections();
    const target = secs.find((s) => s.id === id);
    if (!target) return false;
    if (parentId) {
      if (parentId === id) return false;
      if (!secs.some((s) => s.id === parentId)) return false;
      // parentId가 id의 후손이면 순환 — 조상을 거슬러 올라가며 확인한다.
      const byId = new Map(secs.map((s) => [s.id, s]));
      for (let cur = byId.get(parentId); cur; cur = cur.parentId
             ? byId.get(cur.parentId) : undefined)
        if (cur.parentId === id) return false;
    }
    if (target.parentId === parentId) return false; // 제자리
    await tx("sections", "readwrite", (s) =>
      s.put({ ...target, parentId, updatedAt: Date.now() }, id));
    return true;
  } catch { return false; }
}

// 섹션을 지우면 그 안의 아트웍은 삭제하지 않고 미분류로 되돌리고,
// 하위 섹션은 지워지는 섹션의 부모(없으면 최상위)로 끌어올린다.
// tombstone: 사용자가 직접 지울 때만 남긴다 — 동기화가 서버의 삭제를 반영할
// 때(remote=true)는 새 기록을 만들면 안 된다(원래 삭제 시각이 매니페스트에 있다).
export async function deleteSection(
  id: string, opts?: { remote?: boolean }): Promise<void> {
  try {
    const target = await tx<Section>("sections", "readonly", (s) => s.get(id));
    const parentId = target?.parentId;
    await tx("sections", "readwrite", (s) => s.delete(id));
    if (!opts?.remote) await putTombstone("sections", id);
    const secs = await listSections();
    await Promise.all(secs.filter((s) => s.parentId === id).map((s) =>
      tx("sections", "readwrite", (st) =>
        st.put({ ...s, parentId, updatedAt: Date.now() }, s.id))));
    const arts = await listArtworks();
    await Promise.all(arts.filter((a) => a.section === id)
      .map((a) => setArtworkSection(a.hash, undefined)));
  } catch { /* 무시 */ }
}

// 동기화가 서버의 삭제를 로컬에 반영할 때 쓰는 원시 삭제 — tombstone을 새로
// 남기지 않는다(putTombstone하면 삭제 이후의 재추가가 또 죽는다).
export async function removeArtworkRaw(hash: string): Promise<void> {
  try { await tx("artworks", "readwrite", (s) => s.delete(hash)); }
  catch { /* 무시 */ }
}

// ---------------------------------------------------------------- 결과 세션
// 분석 결과를 브라우저에 보존해 새로고침·재방문 후에도 이어서 볼 수 있게 한다.
// 이미지는 Blob(JPEG/PNG)으로 저장하고, 화면 복원 시 캔버스로 되살린다.
export interface StoredSet {
  name: string;
  setId?: number;
  page?: number;
  pageCount?: number;
  instance?: number;      // 다중 샘플 모드 — 몇 번째 샘플인지
  instanceCount?: number;
  error?: string;
  result?: PipelineResult;
  fb?: SetFb;
  annotated?: Blob;
  refImage?: Blob;
  alignedImage?: Blob;
  refFile?: { blob: Blob; name: string; type: string };
  testFile?: { blob: Blob; name: string; type: string };
}

export interface StoredSession {
  sets: StoredSet[];
  analyzedAt: number; // 분석을 수행한 시각(epoch ms) — 결과 화면에 표시
}

export async function saveSession(
  sets: StoredSet[], analyzedAt: number = Date.now()): Promise<void> {
  try {
    await tx("session", "readwrite", (s) =>
      s.put({ sets, analyzedAt, savedAt: Date.now() }, "last"));
  } catch { /* 저장 실패는 기능에 영향 없음 */ }
}

export async function loadSession(): Promise<StoredSession | null> {
  try {
    const rec = await tx<{ sets: StoredSet[]; analyzedAt?: number; savedAt: number }>(
      "session", "readonly", (s) => s.get("last"));
    if (!rec) return null;
    if (Date.now() - rec.savedAt > SESSION_TTL_MS) {
      clearSession();
      return null;
    }
    // 구버전 레코드(analyzedAt 없음)는 저장 시각으로 대체
    return { sets: rec.sets, analyzedAt: rec.analyzedAt ?? rec.savedAt };
  } catch { return null; }
}

export async function clearSession(): Promise<void> {
  try {
    await tx("session", "readwrite", (s) => s.delete("last"));
  } catch { /* 무시 */ }
}

// -------------------------------------------------------- 영구 저장(유실 방지)
// 원본 보관함은 IndexedDB에 있는데, 브라우저는 저장공간 압박 시 "best-effort"
// 데이터를 임의 삭제할 수 있다. persist()로 저장소를 'persistent'로 승격하면
// 사용자가 명시적으로 지우기 전까지 자동 삭제되지 않는다(유실 1차 방어).
export async function requestPersistentStorage(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted?.()) return true;
    return await navigator.storage.persist();
  } catch { return false; }
}

// 보관함 용량 추정(사용/여유) — 관리 화면에서 유실 위험을 가늠하는 용도.
export async function storageEstimate(): Promise<
  { usage: number; quota: number; persisted: boolean } | null> {
  try {
    if (!navigator.storage?.estimate) return null;
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const persisted = (await navigator.storage.persisted?.()) ?? false;
    return { usage, quota, persisted };
  } catch { return null; }
}

// 아트웍 파일을 가져온다. 로컬에 본체(blob)가 없고 서버 URL만 있으면(공용
// 보관함에서 목록만 받아온 항목) 그 자리에서 내려받아 캐시에 채운 뒤 돌려준다.
export async function getArtworkFile(hash: string): Promise<File | null> {
  try {
    const rec = await tx<Omit<ArtworkEntry, "hash">>(
      "artworks", "readonly", (s) => s.get(hash));
    if (!rec) return null;
    let blob = rec.blob;
    if (!blob && rec.url) {
      const res = await fetch(rec.url);
      if (!res.ok) throw new Error(`다운로드 실패(${res.status})`);
      blob = await res.blob();
      pruneBlobCache().catch(() => {});
    }
    if (!blob) return null;
    tx("artworks", "readwrite", (s) =>
      s.put({ ...rec, blob, lastUsed: Date.now() }, hash)).catch(() => {});
    return new File([blob], rec.name, { type: rec.type });
  } catch { return null; }
}

// ------------------------------------------------ 로컬 blob 캐시 정리(LRU)
// 서버가 원본을 갖고 있는 항목(url 있음)은 로컬 blob을 비워도 잃는 게 없다.
// 저장 공간이 한도의 60%를 넘으면 오래 안 쓴 것부터 blob만 비워(목록·메타는
// 유지) 50% 아래로 내린다 — 보관함이 200장을 넘어도 로컬 할당량에 안 걸린다.
const PRUNE_START = 0.6, PRUNE_STOP = 0.5;

export async function pruneBlobCache(): Promise<number> {
  try {
    const est = await storageEstimate();
    if (!est?.quota || est.usage / est.quota < PRUNE_START) return 0;
    let usage = est.usage;
    const target = est.quota * PRUNE_STOP;
    const candidates = (await listArtworks())
      .filter((a) => a.blob && a.url)
      .sort((a, b) => a.lastUsed - b.lastUsed);
    let n = 0;
    for (const a of candidates) {
      if (usage <= target) break;
      const { blob, ...rest } = a;
      const { hash, ...noHash } = rest;
      await tx("artworks", "readwrite", (s) => s.put(noHash, hash));
      usage -= blob!.size;
      n++;
    }
    return n;
  } catch { return 0; }
}

// -------------------------------------------------- 보관함 동기화(매니페스트)
// 서버 보관함은 "매니페스트(메타데이터 JSON) + 파일 단위 blob"으로 주고받는다.
// 전체를 base64 JSON 한 덩어리로 만들던 v1 방식은 보관함이 커지면(수백 MB)
// 문자열 하나가 메모리를 통째로 먹어 탭이 죽는다. 파일을 따로 올리면
//  · 이미 서버에 있는 해시는 건너뛰어(내용 주소 지정) 증분 동기화가 되고
//  · 중간에 끊겨도 다음 시도가 이어서 진행되며
//  · 메모리 사용이 "가장 큰 파일 1개" 수준으로 고정된다.
// v3: 삭제 기록(deleted)을 실어 "지웠다"가 기기 간에 전파되게 했다. v2 이하
// 매니페스트(deleted 없음)도 그대로 읽힌다 — 빈 기록으로 간주.
export const LIBRARY_MANIFEST_VERSION = 3;

export interface ArtworkMeta {
  hash: string;
  name: string;
  size: number;
  type: string;
  section?: string;
  updatedAt?: number; // 삭제 기록과 승부 — 삭제 이후 재추가만 살아남는다
}

export interface LibraryManifest {
  version: number;
  exportedAt: number;
  sections: Section[];
  artworks: ArtworkMeta[]; // 파일 본체는 별도 blob(library/f/<hash>)
  deleted?: Tombstones;    // v3 — 삭제 전파용
}

// 보관함 메타데이터만 모아 매니페스트로. 파일 본체는 읽지 않는다(가볍다).
export async function exportManifest(): Promise<LibraryManifest> {
  const [arts, secs, dead] = await Promise.all(
    [listArtworks(), listSections(), listTombstones()]);
  return {
    version: LIBRARY_MANIFEST_VERSION,
    exportedAt: Date.now(),
    sections: secs,
    artworks: arts.map((a) => ({ hash: a.hash, name: a.name, size: a.size,
                                 type: a.type, section: a.section,
                                 updatedAt: a.updatedAt })),
    deleted: dead,
  };
}

// 두 매니페스트를 합친다 — 공용 보관함의 병합 규칙:
//  · 항목은 합집합, 같은 키는 primary(올리는 쪽) 승.
//  · 삭제 기록도 합집합(더 늦은 시각 승). 삭제 시각보다 나중에 갱신된 항목은
//    "삭제 후 재추가"이므로 살리고 그 삭제 기록은 버린다.
export function mergeManifests(
  primary: LibraryManifest, other: LibraryManifest | null): LibraryManifest {
  const unionDead = (a: Record<string, number> = {},
                     b: Record<string, number> = {}) => {
    const out = { ...a };
    for (const [k, at] of Object.entries(b)) out[k] = Math.max(out[k] ?? 0, at);
    return out;
  };
  const deadArts = unionDead(primary.deleted?.artworks,
                             other?.deleted?.artworks);
  const deadSecs = unionDead(primary.deleted?.sections,
                             other?.deleted?.sections);

  const secs = new Map((other?.sections ?? []).map((s) => [s.id, s]));
  for (const s of primary.sections) secs.set(s.id, s);
  const arts = new Map((other?.artworks ?? []).map((a) => [a.hash, a]));
  for (const a of primary.artworks) arts.set(a.hash, a);

  for (const [hash, at] of Object.entries(deadArts)) {
    const a = arts.get(hash);
    if (!a) continue;
    if ((a.updatedAt ?? 0) > at) delete deadArts[hash]; // 재추가가 이겼다
    else arts.delete(hash);
  }
  for (const [id, at] of Object.entries(deadSecs)) {
    const s = secs.get(id);
    if (!s) continue;
    if ((s.updatedAt ?? s.createdAt ?? 0) > at) delete deadSecs[id];
    else secs.delete(id);
  }

  return { version: LIBRARY_MANIFEST_VERSION, exportedAt: primary.exportedAt,
           sections: [...secs.values()], artworks: [...arts.values()],
           deleted: { artworks: deadArts, sections: deadSecs } };
}

// 병합된 매니페스트를 로컬 보관함에 반영한다(동기화의 "내려받기 없이 목록만"
// 단계). 파일 본체는 내려받지 않고 서버 URL만 적어 둔다 — 실제 사용 시점에
// getArtworkFile이 내려받는다. 병합에서 사라진(=삭제 전파된) 로컬 항목은 지운다.
export async function applyManifestToLocal(
  merged: LibraryManifest, serverUrls: Map<string, string>): Promise<void> {
  await putSections(merged.sections ?? []);
  const keepSecs = new Set((merged.sections ?? []).map((s) => s.id));
  for (const s of await listSections())
    if (!keepSecs.has(s.id)) await deleteSection(s.id, { remote: true });

  const keepArts = new Set((merged.artworks ?? []).map((a) => a.hash));
  const local = new Map((await listArtworks()).map((a) => [a.hash, a]));
  for (const hash of local.keys())
    if (!keepArts.has(hash)) await removeArtworkRaw(hash);

  for (const a of merged.artworks ?? []) {
    const cur = local.get(a.hash);
    const url = serverUrls.get(a.hash) ?? cur?.url;
    if (cur) {
      // 메타데이터(이름·폴더·URL)만 맞춘다 — blob은 그대로 둔다.
      if (cur.name === a.name && cur.section === a.section && cur.url === url &&
          cur.updatedAt === a.updatedAt) continue;
      const { hash, ...rest } = cur;
      await tx("artworks", "readwrite", (s) =>
        s.put({ ...rest, name: a.name, section: a.section, url,
                updatedAt: a.updatedAt }, hash));
    } else {
      // 새 항목 — 목록에만 추가(blob 없음). 서버에 본체가 없으면(예외 상황)
      // 내려받을 길이 없으므로 목록에도 넣지 않는다.
      if (!url) continue;
      await tx("artworks", "readwrite", (s) =>
        s.put({ name: a.name, size: a.size, type: a.type, url,
                lastUsed: 0, section: a.section, updatedAt: a.updatedAt },
              a.hash));
    }
  }
}

// 보관함에 이미 있는 해시 집합 — 올릴/받을 목록을 추리는 데 쓴다(본체 미로드).
export async function listArtworkHashes(): Promise<Set<string>> {
  try {
    const keys = await tx<IDBValidKey[]>("artworks", "readonly",
      (s) => s.getAllKeys());
    return new Set((keys ?? []).map(String));
  } catch { return new Set(); }
}

export async function getArtworkBlob(hash: string): Promise<Blob | null> {
  try {
    const rec = await tx<Omit<ArtworkEntry, "hash">>(
      "artworks", "readonly", (s) => s.get(hash));
    return rec?.blob ?? null;
  } catch { return null; }
}

// 서버에서 받은 파일 1개를 보관함에 넣는다(이미 있으면 폴더 배정만 유지).
export async function saveArtworkBlob(
  meta: ArtworkMeta, blob: Blob): Promise<void> {
  await tx("artworks", "readwrite", (s) =>
    s.put({ name: meta.name, size: meta.size, type: meta.type, blob,
            lastUsed: Date.now(), section: meta.section }, meta.hash));
}

// 폴더 구조를 통째로 반영(id 보존 — parentId 링크가 유지돼야 한다).
export async function putSections(secs: Section[]): Promise<void> {
  for (const sec of secs) await putSection(sec);
}

// ------------------------------------------------ 구버전 백업 복원(v1 호환)
// v1은 보관함 전체를 base64 JSON 한 파일에 담았다. 새로 만들지는 않지만,
// 서버/디스크에 남아 있는 옛 백업을 되살릴 수 있어야 하므로 읽기는 유지한다.
export interface LibraryBackup {
  version: number;
  exportedAt: number;
  sections: Section[];
  artworks: { hash: string; name: string; size: number; type: string;
              section?: string; dataB64: string }[];
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 섹션 upsert — 원래 id를 보존해 parentId 링크가 유지되게 한다(복원 전용).
async function putSection(sec: Section): Promise<void> {
  try { await tx("sections", "readwrite", (s) => s.put(sec, sec.id)); }
  catch { /* 무시 */ }
}

// v1 백업을 되살린다 — 병합(기존 보관함에 더한다). 같은 해시/섹션 id는 덮어쓴다.
export async function importLibrary(backup: LibraryBackup):
  Promise<{ artworks: number; sections: number }> {
  if (!backup || typeof backup !== "object" || !Array.isArray(backup.artworks))
    throw new Error("백업 파일 형식이 올바르지 않습니다.");
  for (const sec of backup.sections ?? []) await putSection(sec);
  let n = 0;
  for (const a of backup.artworks) {
    try {
      const blob = new Blob([b64ToBytes(a.dataB64).buffer as ArrayBuffer],
                            { type: a.type });
      await tx("artworks", "readwrite", (s) =>
        s.put({ name: a.name, size: a.size, type: a.type, blob,
                lastUsed: Date.now(), section: a.section }, a.hash));
      n++;
    } catch { /* 개별 실패는 건너뛴다 */ }
  }
  return { artworks: n, sections: (backup.sections ?? []).length };
}
