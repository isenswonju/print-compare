// 공용 원본 보관함 — 팀이 어디서 접속하든 **같은 보관함 하나**를 본다. 큰
// 파일(고해상 라벨·PDF)을 위해 클라이언트가 @vercel/blob/client의 upload()로
// Blob에 직접 올리고, 이 함수는 업로드 토큰만 발급한다.
//
// 저장 구조(v2 — 증분 동기화):
//   library/f/<sha256>       원본 파일 1개 = blob 1개. 내용 주소라 같은 파일은
//                            한 번만 올라가고, 재업로드는 덮어쓰기(멱등).
//   library/manifest.json    폴더 트리 + 파일 목록(메타데이터만). 랜덤 접미사를
//                            붙여 URL을 추측 불가하게 두고 최신 것만 쓴다.
// 전체를 base64 JSON 한 덩어리로 올리던 v1은 보관함이 커지면 클라이언트
// 메모리가 터져서 폐지했다(옛 백업은 읽기만 지원 — library/backup.json).
//
// 접근 통제(2026-08-31 오너 결정): 보관함에는 비밀번호가 없다. "어떤 환경에서
// 보든 동일한 스페이스"가 요구사항이라 연결 절차 자체를 없앴다. 보호는
// 엔드포인트 URL을 아는지 하나뿐이다. 남은 방어선은 경로 검증(library/ 아래
// 정해진 두 곳 외에는 토큰을 안 준다)과 파일 크기 상한이다.
// 피드백 관리자 조회(/api/admin)는 여전히 ADMIN_PASSWORD 게이트다 — 별개다.
import { handleUpload } from "@vercel/blob/client";
import { list, del } from "@vercel/blob";
import { setCors, readBody } from "./_cors.js";

const FILE_PREFIX = "library/f/";
const MANIFEST_PREFIX = "library/manifest";
const V1_PREFIX = "library/backup";
const KEEP_MANIFESTS = 5; // 매니페스트 이력만 정리 — 파일(library/f/)은 건드리지 않는다

// list()는 한 번에 최대 1000개만 준다 — 커서로 끝까지 모은다.
async function listAll(prefix) {
  const out = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    out.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return out;
}

const newest = (blobs) =>
  blobs.sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))[0];

// 최신 매니페스트(없으면 구버전 v1 백업)를 찾는다.
async function newestManifest() {
  const m = await listAll(MANIFEST_PREFIX);
  if (m.length) return newest(m);
  const v1 = await listAll(V1_PREFIX);
  return v1.length ? newest(v1) : null;
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method" });

  const body = readBody(req);

  // 서버에 있는 파일 목록 + 최신 매니페스트 URL — 증분 동기화의 출발점.
  if (body?.action === "listfiles") {
    try {
      const [files, manifest] = await Promise.all([
        listAll(FILE_PREFIX), newestManifest()]);
      return res.status(200).json({
        files: files.map((b) => ({
          hash: b.pathname.slice(FILE_PREFIX.length),
          url: b.downloadUrl || b.url,
          size: b.size,
        })),
        manifestUrl: manifest ? (manifest.downloadUrl || manifest.url) : null,
        manifestAt: manifest ? manifest.uploadedAt : null,
      });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  }

  // 최신 매니페스트 URL만 조회(구버전 클라이언트 호환).
  if (body?.action === "geturl") {
    try {
      const m = await newestManifest();
      if (!m) return res.status(200).json({ url: null });
      return res.status(200).json({
        url: m.downloadUrl || m.url, uploadedAt: m.uploadedAt, size: m.size });
    } catch (e) {
      return res.status(500).json({ error: String(e?.message || e) });
    }
  }

  // 업로드 토큰 핸드셰이크(@vercel/blob/client upload()가 호출).
  try {
    const jsonResponse = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async (pathname) => {
        // 비번 없음(공용 보관함) — 경로가 보관함 안인지만 확인한다.
        const isFile = pathname.startsWith(FILE_PREFIX);
        const isManifest = pathname === "library/manifest.json";
        if (!isFile && !isManifest) throw new Error("invalid path");
        return {
          allowedContentTypes: isManifest
            ? ["application/json"]
            : ["image/png", "image/jpeg", "application/pdf",
               "application/octet-stream"],
          // 파일은 콘텐츠 해시가 곧 경로 — 접미사 없이 덮어써 멱등하게 둔다.
          // 매니페스트는 접미사를 붙여 URL을 추측 불가하게 유지한다.
          addRandomSuffix: isManifest,
          allowOverwrite: isFile,
          maximumSizeInBytes: 500 * 1024 * 1024, // 파일 1개 상한
        };
      },
      onUploadCompleted: async ({ blob }) => {
        // 매니페스트 이력만 최신 KEEP개로 정리한다. 파일(library/f/)은 다른
        // 매니페스트가 여전히 참조하므로 절대 지우지 않는다.
        if (!blob?.pathname?.startsWith(MANIFEST_PREFIX)) return;
        try {
          const old = (await listAll(MANIFEST_PREFIX))
            .sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt))
            .slice(KEEP_MANIFESTS);
          if (old.length) await del(old.map((b) => b.url));
        } catch { /* 정리는 실패해도 기능에 영향 없음 */ }
      },
    });
    return res.status(200).json(jsonResponse);
  } catch (e) {
    return res.status(400).json({ error: String(e?.message || e) });
  }
}
