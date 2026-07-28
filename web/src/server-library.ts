// 공용 서버 보관함(안 A) 클라이언트. 큰 파일을 위해 @vercel/blob/client의
// upload()로 Blob에 직접 올리고(함수는 비번 검증 후 토큰만 발급), 불러오기는
// 함수에서 최신 백업 URL을 받아 내려받아 병합한다.
import { upload } from "@vercel/blob/client";
import { exportLibrary, importLibrary, type LibraryBackup } from "./cache.ts";
import { branding } from "./branding.ts";

export const hasLibraryServer = !!branding.libraryUrl;

function friendly(e: unknown): Error {
  const msg = String((e as Error)?.message || e);
  if (/unauthorized|401/i.test(msg))
    return new Error("비밀번호가 올바르지 않습니다.");
  return e instanceof Error ? e : new Error(msg);
}

// 로컬 보관함 전체를 서버로 백업(업로드). 비번은 서버 env와 대조된다.
export async function pushLibraryToServer(
  password: string): Promise<{ artworks: number; sections: number }> {
  if (!branding.libraryUrl) throw new Error("서버 보관함이 설정되지 않았습니다.");
  try {
    const backup = await exportLibrary();
    const blob = new Blob([JSON.stringify(backup)], { type: "application/json" });
    await upload("library/backup.json", blob, {
      access: "public",
      handleUploadUrl: branding.libraryUrl,
      clientPayload: password,
      contentType: "application/json",
    });
    return { artworks: backup.artworks.length, sections: backup.sections.length };
  } catch (e) { throw friendly(e); }
}

// 서버의 최신 백업을 내려받아 로컬 보관함에 병합. 서버에 백업이 없으면 null.
export async function pullLibraryFromServer(
  password: string): Promise<{ artworks: number; sections: number } | null> {
  if (!branding.libraryUrl) throw new Error("서버 보관함이 설정되지 않았습니다.");
  const r = await fetch(branding.libraryUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "geturl", password }),
  });
  if (r.status === 401) throw new Error("비밀번호가 올바르지 않습니다.");
  if (!r.ok) throw new Error(`서버 오류: ${r.status}`);
  const { url } = await r.json();
  if (!url) return null; // 아직 서버에 백업이 없음
  const data = (await fetch(url).then((x) => x.json())) as LibraryBackup;
  return importLibrary(data); // 병합(로컬 유지 + 서버 항목 추가)
}
