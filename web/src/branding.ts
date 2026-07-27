// 브랜딩 설정 레이어 — 이 파일이 upstream(브랜드중립 Inkspect)과 downstream
// (i-SENS 등)의 유일한 차이점이 되도록 격리한다. 기능 코드는 여기만 참조하고,
// 브랜드/도메인 변형은 이 파일만 갈아끼우면 되므로 upstream 패치 머지가 깨끗하다.
//
// === 이 버전: 브랜드 중립(upstream, Inkspect) ===
export interface BrandMark {
  text: string;
  color: string; // hex
}

export interface Branding {
  name: string;          // 서비스명 (document.title 등)
  wordmark: BrandMark[]; // 헤더 로고(워드마크) 조각 — logo 이미지가 없을 때 사용
  logo?: string;         // 헤더 로고 이미지 URL(설정 시 워드마크 대신 이미지 표시)
}

export const branding: Branding = {
  name: "Inkspect",
  // Inkspect 워드마크: "Ink"(먹색) + "spect"(강조색)
  wordmark: [
    { text: "Ink", color: "#111827" },
    { text: "spect", color: "#c0392b" },
  ],
};
