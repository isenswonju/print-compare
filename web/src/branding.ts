// i-SENS 전용 앱 설정. i-SENS와 Inkspect는 이제 별개 제품으로 진행하며 분석
// 엔진(compare_artwork.py / pipeline / engine.ts)만 공유한다. UI·브랜드·수집기는
// 각자 독립. (upstream 전체 머지 금지 — 엔진 파일만 선별 동기화)
import isensLogo from "./assets/isens-logo.png";

export interface BrandMark {
  text: string;
  color: string; // hex
}

export interface Branding {
  name: string;          // 서비스명 (document.title 등)
  wordmark: BrandMark[]; // 헤더 로고(워드마크) 조각 — logo 이미지가 없을 때 사용
  logo?: string;         // 헤더 로고 이미지 URL(설정 시 워드마크 대신 이미지 표시)
  // 피드백 서버리스 수집기. 사내망·정적 배포 어디서든 여기로 수집되고,
  // adminUrl로 헤더 관리자 입구를 노출한다(비번은 수집기 서버 env).
  feedback?: { collectUrl?: string; adminUrl?: string };
  // 공용 서버 보관함(안 A) 엔드포인트. 인증 없이 업로드
  // 토큰을 발급하고 geturl로 최신 백업 URL을 돌려준다. 미설정이면 서버 동기화
  // 버튼을 숨긴다(로컬 백업/복원은 항상 가능).
  libraryUrl?: string;
}

export const branding: Branding = {
  name: "인쇄 검수 · i-SENS",
  // 실제 i-SENS 로고 이미지(규정선 제거·투명 배경). 이미지가 있으면 헤더에 사용.
  logo: isensLogo,
  // 로고 로드 실패 시 폴백 워드마크: 그린 "i" + 네이비 "-SENS"
  wordmark: [
    { text: "i", color: "#78be20" },
    { text: "-SENS", color: "#171c8f" },
  ],
  feedback: {
    collectUrl: "https://print-compare-feedback.vercel.app/api/feedback",
    adminUrl: "https://print-compare-feedback.vercel.app/api/admin",
  },
  libraryUrl: "https://print-compare-feedback.vercel.app/api/library",
};
