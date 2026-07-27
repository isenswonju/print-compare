// 브랜딩 설정 레이어 — 이 파일이 upstream(브랜드중립 Inkspect)과 downstream
// (i-SENS)의 유일한 차이점이 되도록 격리한다. 기능 코드는 여기만 참조하고,
// upstream 패치는 이 파일을 건드리지 않으므로 머지가 깨끗하다.
//
// === 이 버전: i-SENS 전용(downstream) ===
export interface BrandMark {
  text: string;
  color: string; // hex
}

export interface Branding {
  name: string;          // 서비스명 (document.title 등)
  wordmark: BrandMark[]; // 헤더 로고(워드마크) 조각
}

export const branding: Branding = {
  name: "인쇄 검수 · i-SENS",
  // i-SENS 워드마크: 그린 "i" + 네이비 "-SENS"
  wordmark: [
    { text: "i", color: "#78be20" },
    { text: "-SENS", color: "#171c8f" },
  ],
};
