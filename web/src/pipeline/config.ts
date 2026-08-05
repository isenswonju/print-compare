// compare_artwork.py Config 포트 — 값은 Python 원본과 동일하게 유지할 것
export const REF_BASE_WIDTH = 5564;

export const defaultConfig = {
  tol: 5,
  tolFallback: 13,
  // 60→40: 미검출 가혹 테스트에서 50px급 결함(여백 잉크 스팟 r=4)을 놓쳤고,
  // 40에서는 회귀 픽스처 오탐이 늘지 않았다(2건 유지, 정답 9/9).
  minArea: 40,
  useOcr: true,
  useTileRefine: true,

  // 전역 정합
  orbFeatures: 20000,
  loweRatio: 0.75,
  ransacThresh: 3.0,
  minInliers: 300,
  scaleRange: [0.9, 1.1] as [number, number],
  downscaleLong: 2000,

  // 타일 정합
  tile: 768,
  overlap: 128,
  minResponse: 0.05,
  maxShift: 20.0,

  // 이진화 (bg_kernel 81은 1/2 축소 후 41로 근사 — flattenBackground 참고)
  bgKernel: 81,
  threshBlock: 41,
  threshC: 18,

  // 군집화
  mergeKernel: 31,
  marginRatio: 0.06,

  // 망점 오탐 억제
  extraMaxNorm: 190,
  missingMaxRef: 190,

  // 리플로우 억제
  reflowSearchY: 200,
  reflowSearchX: 60,
  reflowPad: 48,
  reflowMinCorr: 0.85,
  reflowExclude: 12,
  reflowMinCover: 0.6,

  // 인쇄 농도 검사(3.4b) — 옅게 인쇄된 결함. 판정은 페이지 중앙값 대비
  // 상대값이라 전체적으로 옅은 인쇄는 통과하고 국소적으로 흐린 글자만 걸린다.
  coverMinArea: 120,   // 검사 대상 REF 잉크 덩어리 최소 면적(REF 폭 5564 기준)
  coverMerge: 3,       // 붙은 획만 잇는 최소 팽창(글자 단위 유지)
  coverPad: 3,         // TEST를 훑는 여유(px) — 잔여 정합 오차 흡수
  coverRefMax: 190,    // 농도 비교 대상 REF 잉크의 밝기 상한(배경 평탄화 후 기준
                       // = 배경보다 25% 이상 어두운 픽셀만). 회색 톤 박스(210)와
                       // 배경 대비 10 남짓인 망점 잡티가 섞이면 TEST만 평탄화되는
                       // 비대칭 때문에 통째로 "옅은 인쇄" 오탐이 된다.
                       // 근거값은 missingMaxRef와 동일.
  fadeRel: 0.70,       // 농도비가 페이지 중앙값의 이 배수 미만이면 옅은 인쇄
  fadeAbs: 0.80,       // 동시에 이 절대값 미만일 때만(전체가 옅은 경우 방어)
  fadeGuard: 0.03,     // 판정선 가드밴드 — 선 3% 이내는 엔진 간 수치 요동 범위라
                       // 보고하지 않는다(실측: 오탐 0.8% vs 실결함 37%+, 8/5)

  // 뒷비침
  ghostLo: 150,
  ghostHi: 225,
  ghostBlur: 7,
  ghostBandHi: 214,
  ghostRefWhite: 215,
  ghostRefErode: 9,
  ghostMerge: 61,
  ghostMinArea: 800,

  // OCR
  ocrMinConf: 40,
};

export type PipelineConfig = typeof defaultConfig;
