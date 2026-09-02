// 피드백 수집 — 외부(정적 배포)에서도 POST로 받아 Vercel Blob에 저장한다.
// 클라이언트는 slim 페이로드(결함 크롭+메타, 전체 라벨 원본 제외)를 보낸다.
import { put } from "@vercel/blob";
import { setCors, readBody } from "./_cors.js";

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "method" });
  try {
    const body = readBody(req);
    if (!body || !Array.isArray(body.items) || body.items.length === 0)
      return res.status(400).json({ error: "no items" });
    const rec = {
      received: new Date().toISOString(),
      origin: req.headers.origin || null,
      data: body,
    };
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const { url } = await put(`feedback/${ts}.json`, JSON.stringify(rec), {
      access: "public",          // 키에 랜덤 접미사 → URL 추측 불가
      addRandomSuffix: true,
      contentType: "application/json",
    });
    return res.status(200).json({ ok: true, url });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
}
