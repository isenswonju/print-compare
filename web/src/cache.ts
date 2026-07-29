// 브라우저 캐시 (IndexedDB) — 전자동, 관리 불필요.
//  * refWords: 아트웍(REF) 파일 해시 → OCR 단어 목록. 같은 아트웍 재검수 시
//    REF OCR(~90초)을 통째로 건너뛴다. 아트웍이 개정되면 해시가 달라져
//    자동으로 새로 계산된다.
//  * artworks: 검수했던 아트웍 원본 파일. "최근 아트웍" 원클릭 재사용.
//    LRU 50개 초과분은 자동 삭제.
import type { PipelineResult, SetFb, Word } from "./types.ts";

const DB_NAME = "artwork-compare-cache";
const DB_VER = 3;
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
  blob: Blob;
  lastUsed: number;
  section?: string; // 소속 섹션 id(없으면 미분류)
}

export interface Section {
  id: string;
  name: string;
  createdAt: number;
  parentId?: string; // 상위 섹션 id(없으면 최상위). 중첩 폴더 지원.
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("refWords"))
        db.createObjectStore("refWords");
      if (!db.objectStoreNames.contains("artworks"))
        db.createObjectStore("artworks");
      if (!db.objectStoreNames.contains("session"))
        db.createObjectStore("session");
      if (!db.objectStoreNames.contains("sections"))
        db.createObjectStore("sections");
    };
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
  return dbPromise;
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

// 아트웍은 영구 보관(자동 삭제 없음) — 사용자가 명시적으로 삭제할 때만 지워진다.
// 재저장 시 기존 폴더 배정은 유지한다(section 인자는 신규 저장일 때만 쓰인다 —
// 보관함으로 직접 드롭한 파일을 그 폴더에 바로 넣기 위한 것).
export async function saveArtwork(
  hash: string, file: File, section?: string): Promise<void> {
  try {
    const existing = await tx<Omit<ArtworkEntry, "hash">>(
      "artworks", "readonly", (s) => s.get(hash));
    await tx("artworks", "readwrite", (s) =>
      s.put({ name: file.name, size: file.size, type: file.type,
              blob: file, lastUsed: Date.now(),
              section: existing ? existing.section : section }, hash));
  } catch { /* 캐시 실패는 기능에 영향 없음 */ }
}

export async function deleteArtwork(hash: string): Promise<void> {
  try {
    await tx("artworks", "readwrite", (s) => s.delete(hash));
  } catch { /* 무시 */ }
}

export async function setArtworkSection(
  hash: string, section: string | undefined): Promise<void> {
  try {
    const rec = await tx<Omit<ArtworkEntry, "hash">>(
      "artworks", "readonly", (s) => s.get(hash));
    if (!rec) return;
    await tx("artworks", "readwrite", (s) => s.put({ ...rec, section }, hash));
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
      name, createdAt: Date.now(), parentId,
    };
    await tx("sections", "readwrite", (s) => s.put(sec, sec.id));
    return sec;
  } catch { return null; }
}

export async function renameSection(id: string, name: string): Promise<void> {
  try {
    const rec = await tx<Section>("sections", "readonly", (s) => s.get(id));
    if (!rec) return;
    await tx("sections", "readwrite", (s) => s.put({ ...rec, name }, id));
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
      s.put({ ...target, parentId }, id));
    return true;
  } catch { return false; }
}

// 섹션을 지우면 그 안의 아트웍은 삭제하지 않고 미분류로 되돌리고,
// 하위 섹션은 지워지는 섹션의 부모(없으면 최상위)로 끌어올린다.
export async function deleteSection(id: string): Promise<void> {
  try {
    const target = await tx<Section>("sections", "readonly", (s) => s.get(id));
    const parentId = target?.parentId;
    await tx("sections", "readwrite", (s) => s.delete(id));
    const secs = await listSections();
    await Promise.all(secs.filter((s) => s.parentId === id).map((s) =>
      tx("sections", "readwrite", (st) => st.put({ ...s, parentId }, s.id))));
    const arts = await listArtworks();
    await Promise.all(arts.filter((a) => a.section === id)
      .map((a) => setArtworkSection(a.hash, undefined)));
  } catch { /* 무시 */ }
}

// ---------------------------------------------------------------- 결과 세션
// 분석 결과를 브라우저에 보존해 새로고침·재방문 후에도 이어서 볼 수 있게 한다.
// 이미지는 Blob(JPEG/PNG)으로 저장하고, 화면 복원 시 캔버스로 되살린다.
export interface StoredSet {
  name: string;
  setId?: number;
  page?: number;
  pageCount?: number;
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

export async function getArtworkFile(hash: string): Promise<File | null> {
  try {
    const rec = await tx<Omit<ArtworkEntry, "hash">>(
      "artworks", "readonly", (s) => s.get(hash));
    if (!rec) return null;
    tx("artworks", "readwrite", (s) =>
      s.put({ ...rec, lastUsed: Date.now() }, hash)).catch(() => {});
    return new File([rec.blob], rec.name, { type: rec.type });
  } catch { return null; }
}

// -------------------------------------------------- 보관함 동기화(매니페스트)
// 서버 보관함은 "매니페스트(메타데이터 JSON) + 파일 단위 blob"으로 주고받는다.
// 전체를 base64 JSON 한 덩어리로 만들던 v1 방식은 보관함이 커지면(수백 MB)
// 문자열 하나가 메모리를 통째로 먹어 탭이 죽는다. 파일을 따로 올리면
//  · 이미 서버에 있는 해시는 건너뛰어(내용 주소 지정) 증분 동기화가 되고
//  · 중간에 끊겨도 다음 시도가 이어서 진행되며
//  · 메모리 사용이 "가장 큰 파일 1개" 수준으로 고정된다.
export const LIBRARY_MANIFEST_VERSION = 2;

export interface ArtworkMeta {
  hash: string;
  name: string;
  size: number;
  type: string;
  section?: string;
}

export interface LibraryManifest {
  version: number;
  exportedAt: number;
  sections: Section[];
  artworks: ArtworkMeta[]; // 파일 본체는 별도 blob(library/f/<hash>)
}

// 보관함 메타데이터만 모아 매니페스트로. 파일 본체는 읽지 않는다(가볍다).
export async function exportManifest(): Promise<LibraryManifest> {
  const [arts, secs] = await Promise.all([listArtworks(), listSections()]);
  return {
    version: LIBRARY_MANIFEST_VERSION,
    exportedAt: Date.now(),
    sections: secs,
    artworks: arts.map((a) => ({ hash: a.hash, name: a.name, size: a.size,
                                 type: a.type, section: a.section })),
  };
}

// 두 매니페스트를 합친다(공용 보관함이라 남의 항목을 지우면 안 된다).
// 같은 키는 primary가 이긴다 — 올리는 쪽의 최신 상태를 반영.
export function mergeManifests(
  primary: LibraryManifest, other: LibraryManifest | null): LibraryManifest {
  if (!other) return primary;
  const secs = new Map((other.sections ?? []).map((s) => [s.id, s]));
  for (const s of primary.sections) secs.set(s.id, s);
  const arts = new Map((other.artworks ?? []).map((a) => [a.hash, a]));
  for (const a of primary.artworks) arts.set(a.hash, a);
  return { version: LIBRARY_MANIFEST_VERSION, exportedAt: primary.exportedAt,
           sections: [...secs.values()], artworks: [...arts.values()] };
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
