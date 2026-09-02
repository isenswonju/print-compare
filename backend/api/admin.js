// 피드백 조회/정리.
//
// 액션:
//   (없음)             목록 조회 — 최근 LIMIT건 + 확인 처리된 id 목록
//   action: "read"     확인/미확인 토글 — { ids: [...], read: true|false }
//   action: "delete"   피드백 삭제 — { ids: [...] }
//
// 2026-09-02 부터 비밀번호를 쓰지 않는다 — 보관함(/api/library)이 이미
// 무인증이고, 팀 누구나 피드백 상태를 맞출 수 있어야 하기 때문이다.
// 삭제는 앱 화면에서 두 번 눌러 확정하는 단계가 실수를 막는다.
//
// id는 blob 경로의 SHA-256 앞 16자다. 경로 자체(랜덤 접미사 포함)가 곧 피드백
// 공개 URL이라 밖으로 내보내지 않는다 — 확인 상태 파일에도 id만 적는다.
import { list, put, del } from "@vercel/blob";
import { createHash } from "node:crypto";
import { setCors, readBody } from "./_cors.js";

const LIMIT = 100;            // 한 번에 본문까지 읽어오는 최대 건수
const READ_PREFIX = "state/read";
const KEEP_STATE = 3;         // 확인 상태 파일 이력 보관 수

const idOf = (pathname) =>
  createHash("sha256").update(pathname).digest("hex").slice(0, 16);

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

const byNewest = (blobs) =>
  [...blobs].sort((a, b) => new Date(b.uploadedAt) - new Date(a.uploadedAt));

// 확인 처리된 id 집합. 덮어쓰기 대신 매번 새 파일로 써서(랜덤 접미사) CDN
// 캐시에 옛 내용이 남는 문제를 피한다 — 최신 것만 읽고 나머지는 정리한다.
async function loadRead() {
  const blobs = byNewest(await listAll(READ_PREFIX));
  if (!blobs.length) return [];
  try {
    const r = await fetch(blobs[0].downloadUrl || blobs[0].url);
    const data = await r.json();
    return Array.isArray(data?.ids) ? data.ids : [];
  } catch { return []; }
}

async function saveRead(ids) {
  await put(`${READ_PREFIX}.json`, JSON.stringify({ ids, savedAt: Date.now() }), {
    access: "public", addRandomSuffix: true, contentType: "application/json",
  });
  try {
    const old = byNewest(await listAll(READ_PREFIX)).slice(KEEP_STATE);
    if (old.length) await del(old.map((b) => b.url));
  } catch { /* 정리는 실패해도 기능에 영향 없음 */ }
}

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method" });

  const body = readBody(req);
  const { action } = body;

  try {
    // 확인/미확인 토글 — 여러 건을 한 번에.
    if (action === "read") {
      const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
      const cur = new Set(await loadRead());
      for (const id of ids) body.read ? cur.add(id) : cur.delete(id);
      await saveRead([...cur]);
      return res.status(200).json({ ok: true, read: [...cur] });
    }

    // 삭제 — id로 지정된 blob만 지우고 확인 상태에서도 뺀다.
    if (action === "delete") {
      const wanted = new Set(Array.isArray(body.ids) ? body.ids.map(String) : []);
      if (!wanted.size) return res.status(400).json({ error: "no ids" });
      const targets = (await listAll("feedback/"))
        .filter((b) => wanted.has(idOf(b.pathname)));
      if (targets.length) await del(targets.map((b) => b.url));
      const cur = (await loadRead()).filter((id) => !wanted.has(id));
      await saveRead(cur);
      return res.status(200).json({ ok: true, deleted: targets.length });
    }

    // 목록 조회.
    const blobs = byNewest(await listAll("feedback/"));
    const recent = blobs.slice(0, LIMIT);
    const read = await loadRead();
    const items = await Promise.all(recent.map(async (b) => {
      const id = idOf(b.pathname);
      try {
        const r = await fetch(b.downloadUrl || b.url);
        const { received, origin, data } = await r.json();
        return { id, uploadedAt: b.uploadedAt, size: b.size,
                 received, origin, data };
      } catch {
        return { id, uploadedAt: b.uploadedAt, size: b.size,
                 error: "read failed" };
      }
    }));
    return res.status(200).json({
      count: blobs.length, shown: items.length, items, read });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
