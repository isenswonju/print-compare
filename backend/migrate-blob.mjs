// 기존 Vercel Blob을 새 회사 Store로 복사한다. 원본은 절대 삭제하지 않는다.
// OLD_BLOB_READ_WRITE_TOKEN / NEW_BLOB_READ_WRITE_TOKEN 환경변수가 필요하다.
import { list, put } from "@vercel/blob";

const oldToken = process.env.OLD_BLOB_READ_WRITE_TOKEN;
const newToken = process.env.NEW_BLOB_READ_WRITE_TOKEN;
if (!oldToken || !newToken) throw new Error("두 Blob 토큰이 모두 필요합니다.");

async function listAll(token) {
  const blobs = [];
  let cursor;
  do {
    const page = await list({ token, cursor, limit: 1000 });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return blobs;
}

const source = await listAll(oldToken);
const before = await listAll(newToken);
const existing = new Map(before.map((b) => [b.pathname, b.size]));
console.log(`원본 ${source.length}개, 새 Store 기존 ${before.length}개`);

let copied = 0;
for (const [index, blob] of source.entries()) {
  if (existing.get(blob.pathname) === blob.size) continue;
  const response = await fetch(blob.downloadUrl || blob.url);
  if (!response.ok || !response.body)
    throw new Error(`다운로드 실패: ${blob.pathname} (${response.status})`);
  await put(blob.pathname, response.body, {
    token: newToken,
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: blob.contentType || undefined,
  });
  copied += 1;
  console.log(`[${index + 1}/${source.length}] ${blob.pathname}`);
}

const after = await listAll(newToken);
const sourceBytes = source.reduce((n, b) => n + b.size, 0);
const afterByPath = new Map(after.map((b) => [b.pathname, b.size]));
const missing = source.filter((b) => afterByPath.get(b.pathname) !== b.size);
console.log(`복사 ${copied}개, 검증 ${after.length}개/${sourceBytes} bytes`);
if (missing.length) {
  console.error(`누락 또는 크기 불일치 ${missing.length}개`);
  process.exit(1);
}
console.log("Blob 이전 검증 완료 — 기존 Store는 삭제하지 않았습니다.");
