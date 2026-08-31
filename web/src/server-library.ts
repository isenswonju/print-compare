// 공용 서버 보관함 클라이언트 — 서버가 원본(source of truth)이고, 브라우저의
// IndexedDB는 그 캐시다. 팀 전원이 같은 보관함 하나를 본다(개인 보관함 없음).
// 비밀번호·로그인 없음: 어떤 기기·브라우저로 열어도 연결 절차 없이 곧바로
// 같은 보관함이 보여야 한다는 게 요구사항이다(2026-08-31 오너 결정).
//
// 동기화는 한 방향씩이 아니라 한 번에 양방향으로 맞춘다(syncLibraryWithServer):
//   1) 서버 파일 목록 + 최신 매니페스트를 받고
//   2) 로컬 상태와 병합(삭제 기록 포함 — 삭제도 기기 간 전파된다)
//   3) 서버에 없는 로컬 파일만 올리고
//   4) 병합 결과를 로컬 목록에 반영(파일 본체는 내려받지 않는다 — 목록만.
//      본체는 실제 사용할 때 getArtworkFile이 내려받는다)
//   5) 달라졌으면 병합 매니페스트를 서버에 올린다
// 파일은 내용 주소(library/f/<해시>)라 한 번만 올라가고, 메모리 사용은
// "가장 큰 파일 1개" 수준으로 고정된다. 보관함이 수백 장이어도 로컬 저장
// 공간에 안 걸린다 — 로컬은 최근 쓴 것만 blob을 들고 있다(pruneBlobCache).
import { upload } from "@vercel/blob/client";
import { applyManifestToLocal, exportManifest, getArtworkBlob, importLibrary,
         mergeManifests, pruneBlobCache, replaceTombstones,
         type LibraryBackup, type LibraryManifest } from "./cache.ts";
import { branding } from "./branding.ts";

export const hasLibraryServer = !!branding.libraryUrl;

// 동시 전송 수 — 브라우저 연결 한도(호스트당 6)와 서버 토큰 발급 부담 사이 절충.
const CONCURRENCY = 3;
const FILE_PREFIX = "library/f/";
const MANIFEST_PATH = "library/manifest.json";

export interface SyncProgress {
  phase: "목록 확인" | "올리는 중" | "마무리";
  done: number;
  total: number;
}
export type OnProgress = (p: SyncProgress) => void;

export interface SyncResult {
  artworks: number;   // 병합 후 전체 원본 수(=팀 공용 보관함 크기)
  sections: number;   // 폴더 수
  uploaded: number;   // 이번에 서버로 올린 파일 수
  freed: number;      // 저장 공간 확보를 위해 로컬 blob을 비운 수
}

interface ServerFile { hash: string; url: string; size: number }
interface ListFilesResponse { files: ServerFile[]; manifestUrl: string | null }

function friendly(e: unknown): Error {
  const msg = String((e as Error)?.message || e);
  if (/failed to fetch|networkerror|load failed/i.test(msg))
    return new Error("공용 보관함 서버에 연결할 수 없습니다 — 네트워크를 확인해주세요.");
  return e instanceof Error ? e : new Error(msg);
}

function endpoint(): string {
  if (!branding.libraryUrl) throw new Error("서버 보관함이 설정되지 않았습니다.");
  return branding.libraryUrl;
}

// 서버에 올라가 있는 파일 목록 + 최신 매니페스트 URL.
async function listServer(): Promise<ListFilesResponse> {
  const r = await fetch(endpoint(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "listfiles" }),
  });
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

async function fetchV1Backup(url: string | null): Promise<LibraryBackup | null> {
  if (!url) return null;
  try {
    const data = await fetch(url).then((r) => r.json());
    return Array.isArray(data?.artworks) ? (data as LibraryBackup) : null;
  } catch { return null; }
}

// 병합 결과가 서버 매니페스트와 실질적으로 같은지 — 같은데도 매번 올리면
// 매니페스트 이력(서버가 최근 5개만 보관)이 의미 없이 소모된다.
function sameManifest(a: LibraryManifest, b: LibraryManifest | null): boolean {
  if (!b) return false;
  const norm = (m: LibraryManifest) => JSON.stringify({
    sections: [...m.sections].sort((x, y) => x.id.localeCompare(y.id)),
    artworks: [...m.artworks].sort((x, y) => x.hash.localeCompare(y.hash)),
    deleted: m.deleted ?? { artworks: {}, sections: {} },
  });
  return norm(a) === norm(b);
}

// 공용 보관함 동기화(양방향, 한 번에). 어디서 실패해도 로컬 보관함은 깨지지
// 않는다 — 다음 동기화가 이어서 진행한다.
export async function syncLibraryWithServer(
  onProgress?: OnProgress): Promise<SyncResult> {
  try {
    onProgress?.({ phase: "목록 확인", done: 0, total: 0 });
    const server = await listServer();
    let remote = await fetchManifest(server.manifestUrl);

    // 서버에 v1(전체 base64 백업)만 있는 경우 — 1회성 이행: 통째로 되살린 뒤
    // 아래의 일반 경로가 v3 매니페스트를 새로 올린다.
    if (!remote && server.manifestUrl && server.files.length === 0) {
      const v1 = await fetchV1Backup(server.manifestUrl);
      if (v1) await importLibrary(v1);
    }

    const local = await exportManifest();
    const merged = mergeManifests(local, remote);
    const serverUrls = new Map(server.files.map((f) => [f.hash, f.url]));

    // 서버에 없는 파일 중 로컬에 본체가 있는 것만 올린다.
    const todo = merged.artworks.filter((a) => !serverUrls.has(a.hash));
    let done = 0, uploaded = 0;
    onProgress?.({ phase: "올리는 중", done, total: todo.length });
    await pool(todo, async (a) => {
      const blob = await getArtworkBlob(a.hash);
      if (!blob) return; // 본체가 다른 기기에만 있는 항목 — 그 기기가 올린다
      await upload(FILE_PREFIX + a.hash, blob, {
        access: "public",
        handleUploadUrl: endpoint(),
        contentType: a.type || "application/octet-stream",
      });
      uploaded++;
    }, () => onProgress?.({ phase: "올리는 중", done: ++done,
                            total: todo.length }));

    onProgress?.({ phase: "마무리", done: 0, total: 1 });
    // 방금 올린 파일의 URL을 알아야 목록 항목이 내려받기 가능해진다.
    if (uploaded > 0) {
      const after = await listServer();
      for (const f of after.files) serverUrls.set(f.hash, f.url);
    }

    await applyManifestToLocal(merged, serverUrls);
    await replaceTombstones(merged.deleted ?? { artworks: {}, sections: {} });
    const freed = await pruneBlobCache();

    if (!sameManifest(merged, remote)) {
      await upload(MANIFEST_PATH,
        new Blob([JSON.stringify(merged)], { type: "application/json" }), {
          access: "public",
          handleUploadUrl: endpoint(),
          contentType: "application/json",
        });
    }
    return { artworks: merged.artworks.length,
             sections: merged.sections.length, uploaded, freed };
  } catch (e) { throw friendly(e); }
}
