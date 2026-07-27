// compare_artwork.py Config 포트 — 값은 Python 원본과 동일하게 유지할 것
export const REF_BASE_WIDTH = 5564;

export const defaultConfig = {
  tol: 5,
  tolFallback: 13,
  minArea: 60,
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
