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
// 재저장 시 기존 섹션 배정은 유지한다.
export async function saveArtwork(hash: string, file: File): Promise<void> {
  try {
    const existing = await tx<Omit<ArtworkEntry, "hash">>(
      "artworks", "readonly", (s) => s.get(hash));
    await tx("artworks", "readwrite", (s) =>
      s.put({ name: file.name, size: file.size, type: file.type,
              blob: file, lastUsed: Date.now(),
              section: existing?.section }, hash));
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

// ---------------------------------------------------- 보관함 백업/복원(안 C)
// 서버 없이도 유실에 대비하는 최소 안전망 — 보관함 전체(아트웍 원본 + 섹션
// 구조)를 파일 하나로 내보내고 되살린다. 이미지가 이미 압축(PNG/PDF)이라
// zip 압축 이득이 적어 의존성 없이 JSON+base64 단일 파일로 저장한다.
export const LIBRARY_BACKUP_VERSION = 1;

export interface LibraryBackup {
  version: number;
  exportedAt: number;
  sections: Section[];
  artworks: { hash: string; name: string; size: number; type: string;
              section?: string; dataB64: string }[];
}

// 큰 바이너리도 콜스택 넘치지 않게 청크 단위로 base64 인코딩.
function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK)
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  return btoa(bin);
}
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Blob→바이트. 브라우저는 arrayBuffer()가 항상 있지만, 저장소가 돌려준 값이
// 그렇지 않은 환경(fake-indexeddb 등)도 있어 한 겹 감싸는 폴백을 둔다.
async function readBytes(b: Blob): Promise<Uint8Array> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyb = b as any;
  if (typeof anyb?.arrayBuffer === "function")
    return new Uint8Array(await anyb.arrayBuffer());
  if (anyb instanceof Uint8Array) return anyb;
  return new Uint8Array(await new Blob([anyb]).arrayBuffer());
}

// 보관함 전체를 백업 객체로 내보낸다(다운로드는 호출측에서 Blob으로).
export async function exportLibrary(): Promise<LibraryBackup> {
  const [arts, secs] = await Promise.all([listArtworks(), listSections()]);
  const artworks = await Promise.all(arts.map(async (a) => ({
    hash: a.hash, name: a.name, size: a.size, type: a.type,
    section: a.section,
    dataB64: bytesToB64(await readBytes(a.blob)),
  })));
  return { version: LIBRARY_BACKUP_VERSION, exportedAt: Date.now(),
           sections: secs, artworks };
}

// 섹션 upsert — 원래 id를 보존해 parentId 링크가 유지되게 한다(복원 전용).
async function putSection(sec: Section): Promise<void> {
  try { await tx("sections", "readwrite", (s) => s.put(sec, sec.id)); }
  catch { /* 무시 */ }
}

// 백업을 되살린다. 기본은 병합(기존 보관함에 더한다) — 같은 해시/섹션 id는
// 덮어쓴다. replace=true면 기존 보관함을 먼저 비운다.
export async function importLibrary(
  backup: LibraryBackup, opts: { replace?: boolean } = {}):
  Promise<{ artworks: number; sections: number }> {
  if (!backup || typeof backup !== "object" || !Array.isArray(backup.artworks))
    throw new Error("백업 파일 형식이 올바르지 않습니다.");
  if (opts.replace) {
    for (const s of await listSections()) await deleteSection(s.id);
    for (const a of await listArtworks()) await deleteArtwork(a.hash);
  }
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
