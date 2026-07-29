// 공용 서버 보관함(안 A) 클라이언트 — 팀이 어디서든 같은 보관함을 쓴다.
//
// v2부터 "매니페스트 + 파일 단위" 증분 동기화다. 예전에는 보관함 전체를
// base64 JSON 한 덩어리로 올렸는데, 폴더·이미지가 늘면 문자열 하나가 수백 MB가
// 돼 탭이 죽었다. 지금은
//   · 파일은 내용 주소(library/f/<해시>)로 한 번만 올라가고 (이미 있으면 건너뜀)
//   · 메타데이터(폴더 트리 + 파일 목록)만 매니페스트 JSON으로 올린다.
// 덕분에 메모리 사용이 "가장 큰 파일 1개" 수준으로 고정되고, 중간에 끊겨도
// 다음 시도가 이어서 진행된다.
import { upload } from "@vercel/blob/client";
import { exportManifest, getArtworkBlob, importLibrary, listArtworkHashes,
         listSections, mergeManifests, putSections, saveArtworkBlob,
         type LibraryBackup, type LibraryManifest } from "./cache.ts";
import { branding } from "./branding.ts";

export const hasLibraryServer = !!branding.libraryUrl;

// 동시 전송 수 — 브라우저 연결 한도(호스트당 6)와 서버 토큰 발급 부담 사이 절충.
const CONCURRENCY = 3;
const FILE_PREFIX = "library/f/";
const MANIFEST_PATH = "library/manifest.json";

export interface SyncProgress {
  phase: "목록 확인" | "올리는 중" | "내려받는 중" | "마무리";
  done: number;
  total: number;
}
export type OnProgress = (p: SyncProgress) => void;

export interface SyncResult {
  artworks: number;   // 매니페스트 기준 전체 원본 수
  sections: number;   // 폴더 수
  moved: number;      // 이번에 실제로 주고받은 파일 수
  skipped: number;    // 이미 있어 건너뛴 파일 수
}

interface ServerFile { hash: string; url: string; size: number }
interface ListFilesResponse { files: ServerFile[]; manifestUrl: string | null }

function friendly(e: unknown): Error {
  const msg = String((e as Error)?.message || e);
  if (/unauthorized|401/i.test(msg))
    return new Error("비밀번호가 올바르지 않습니다.");
  return e instanceof Error ? e : new Error(msg);
}

function endpoint(): string {
  if (!branding.libraryUrl) throw new Error("서버 보관함이 설정되지 않았습니다.");
  return branding.libraryUrl;
}

// 서버에 올라가 있는 파일 목록 + 최신 매니페스트 URL(비번 게이트).
async function listServer(password: string): Promise<ListFilesResponse> {
  const r = await fetch(endpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "listfiles", password }),
  });
  if (r.status === 401) throw new Error("비밀번호가 올바르지 않습니다.");
  if (!r.ok) throw new Error(`서버 오류: ${r.status}`);
  const data = await r.json();
  return { files: data.files ?? [], manifestUrl: data.manifestUrl ?? null };
}

// 작업 목록을 CONCURRENCY개씩 굴린다. 하나가 실패하면 전체를 멈춘다
// (조용히 빠뜨린 채 "완료"라고 말하지 않기 위해).
async function pool<T>(items: T[], fn: (item: T) => Promise<void>,
                       onStep: () => void): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(CONCURRENCY, items.length) },
    async () => {
      for (let i = next++; i < items.length; i = next++) {
        await fn(items[i]);
        onStep();
      }
    });
  await Promise.all(workers);
}

// 로컬 보관함을 서버로 올린다. 서버에 없는 파일만 전송하고, 매니페스트는
// 서버의 기존 내용과 합쳐서(남의 항목을 지우지 않게) 새로 쓴다.
export async function pushLibraryToServer(
  password: string, onProgress?: OnProgress): Promise<SyncResult> {
  try {
    onProgress?.({ phase: "목록 확인", done: 0, total: 0 });
    const [local, server] = await Promise.all([
      exportManifest(), listServer(password)]);
    const have = new Set(server.files.map((f) => f.hash));
    const todo = local.artworks.filter((a) => !have.has(a.hash));

    let done = 0;
    onProgress?.({ phase: "올리는 중", done, total: todo.length });
    await pool(todo, async (a) => {
      const blob = await getArtworkBlob(a.hash);
      if (!blob) return; // 방금 지워졌으면 조용히 건너뛴다
      await upload(FILE_PREFIX + a.hash, blob, {
        access: "public",
        handleUploadUrl: endpoint(),
        clientPayload: password,
        contentType: a.type || "application/octet-stream",
      });
    }, () => onProgress?.({ phase: "올리는 중", done: ++done, total: todo.length }));

    onProgress?.({ phase: "마무리", done: 0, total: 1 });
    const remote = await fetchManifest(server.manifestUrl);
    const merged = mergeManifests(local, remote);
    await upload(MANIFEST_PATH,
      new Blob([JSON.stringify(merged)], { type: "application/json" }), {
        access: "public",
        handleUploadUrl: endpoint(),
        clientPayload: password,
        contentType: "application/json",
      });
    return { artworks: merged.artworks.length, sections: merged.sections.length,
             moved: todo.length, skipped: local.artworks.length - todo.length };
  } catch (e) { throw friendly(e); }
}

// 매니페스트를 읽는다. 구버전(v1, base64 전체 백업)이면 null을 돌려주고
// 호출측이 v1 경로로 처리한다.
async function fetchManifest(url: string | null): Promise<LibraryManifest | null> {
  if (!url) return null;
  try {
    const data = await fetch(url).then((r) => r.json());
    if (!data || !Array.isArray(data.artworks)) return null;
    if (data.artworks.some((a: { dataB64?: string }) => a?.dataB64)) return null;
    return data as LibraryManifest;
  } catch { return null; }
}

// 서버 보관함을 로컬에 병합한다. 로컬에 없는 파일만 내려받는다.
// 서버에 아무것도 없으면 null.
export async function pullLibraryFromServer(
  password: string, onProgress?: OnProgress): Promise<SyncResult | null> {
  try {
    onProgress?.({ phase: "목록 확인", done: 0, total: 0 });
    const server = await listServer(password);
    if (!server.manifestUrl && server.files.length === 0) return null;

    const manifest = await fetchManifest(server.manifestUrl);
    if (!manifest) {
      // 구버전 백업만 있는 서버 — v1 전체 백업으로 되살린다(1회성 이행 경로).
      const v1 = await fetchV1Backup(server.manifestUrl);
      if (!v1) return null;
      const r = await importLibrary(v1);
      return { artworks: r.artworks, sections: r.sections,
               moved: r.artworks, skipped: 0 };
    }

    await putSections(manifest.sections ?? []);
    const urls = new Map(server.files.map((f) => [f.hash, f.url]));
    const localHashes = await listArtworkHashes();
    const todo = manifest.artworks.filter(
      (a) => !localHashes.has(a.hash) && urls.has(a.hash));

    let done = 0;
    onProgress?.({ phase: "내려받는 중", done, total: todo.length });
    await pool(todo, async (a) => {
      const res = await fetch(urls.get(a.hash)!);
      if (!res.ok) throw new Error(`파일 내려받기 실패(${res.status}) — ${a.name}`);
      await saveArtworkBlob(a, await res.blob());
    }, () => onProgress?.({ phase: "내려받는 중", done: ++done,
                            total: todo.length }));

    const sections = (await listSections()).length;
    return { artworks: manifest.artworks.length, sections,
             moved: todo.length, skipped: manifest.artworks.length - todo.length };
  } catch (e) { throw friendly(e); }
}

async function fetchV1Backup(url: string | null): Promise<LibraryBackup | null> {
  if (!url) return null;
  try {
    const data = await fetch(url).then((r) => r.json());
    return Array.isArray(data?.artworks) ? (data as LibraryBackup) : null;
  } catch { return null; }
}
