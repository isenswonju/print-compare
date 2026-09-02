// CORS 오리진 정책. ALLOWED_ORIGINS(콤마 구분)가 지정되고 '*'가 없으면 그
// 목록만 허용. 미설정이거나 '*' 포함이면 모든 오리진을 반영(수집은 공개 인테이크
// — 사내망 IP가 유동적이라 전체 허용, 관리자 조회는 비밀번호로 별도 보호).
const ALLOWED = (process.env.ALLOWED_ORIGINS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const ALLOW_ALL = ALLOWED.length === 0 || ALLOWED.includes("*");

export function setCors(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOW_ALL || ALLOWED.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
  }
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

export function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  try { return JSON.parse(req.body || "{}"); } catch { return {}; }
}
