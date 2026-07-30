// 공유 타입 정의. opencv.js는 타입 정의가 없어 CV/Mat은 any로 둔다 —
// 엔진의 정확성은 타입이 아니라 Node 하니스(Python 결과 대조)가 보증한다.
export type CV = any;
export type Mat = any;

export type BBox = [number, number, number, number];

export interface ImageDataLike {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export interface Word {
  text: string;
  conf: number;
  bbox: BBox;
  line: [number, number, number];
}

export interface OcrWords {
  refWords: Word[];
  testWords: Word[];
}

export interface Finding {
  id: number;
  type: string;
  severity: string;
  bbox_ref: number[];
  area_px: number;
  near_text: string;
  note: string;
  // 임계값 여유도(정확도 안전망용, Python Finding.metrics 와 동일 계약).
  // margin 1.0 = 임계값에 딱 걸침. 통과했는데 마진이 줄어드는 변경은 아직
  // 안 터진 회귀이므로 bench 가 WARN 으로 잡는다.
  metrics?: { margin: number | null; basis: string };
}

export interface PipelineResult {
  findings: Finding[];
  timings: [string, number][];
  totalMs: number;
  wallMs?: number;
}

export type Severity = "critical" | "major" | "minor";

export interface Disp {
  ktype: string;
  severity: Severity;
  note: string;
}

export interface DispFinding extends Finding {
  disp: Disp;
}

export interface DefectFb {
  fp: boolean;
  cause: string;
  comment: string;
  ktype: string;
  bbox: number[];
}

export interface MissedFb {
  x: number;
  y: number;
  cause?: string;
  comment: string;
}

export interface SetFb {
  defects: Record<string, DefectFb>;
  missed: MissedFb[];
}

export interface ResultItem {
  name: string;         // 세트(품목) 이름
  setId: number;        // 같은 세트의 페이지들을 묶는 id
  page: number;         // 세트 내 페이지 번호(1-based)
  pageCount: number;    // 세트의 총 페이지 수
  error?: string;
  result?: PipelineResult;
  defects?: DispFinding[];
  annotated?: HTMLCanvasElement;
  refCanvas?: HTMLCanvasElement;
  alignedCanvas?: HTMLCanvasElement;
  refFile?: File;
  testFile?: File;
  fb?: SetFb;
  fbStatus?: string; // 세트별 피드백 전송 상태 표시용 (UI 전용)
}

// 한 파일(이미지 1장 또는 PDF N장)을 펼친 페이지 목록. 업로드 영역이 여러
// 파일/페이지를 받을 수 있게 한다(원본 2장 PDF ↔ 인쇄물 2장 등).
export interface FileEntry {
  name: string;   // 원본 파일명
  file: File;     // 원본 파일(라이브러리 보관·재래스터화용)
  pages: File[];  // 래스터화된 페이지 PNG (이미지면 1장)
}

export interface PipelineConfigOverride {
  useOcr?: boolean;
  useTileRefine?: boolean;
}

export interface RunHooks {
  log: (msg: string) => void;
  progress: (stage: string) => void;
  onAligned?: (rgba: Uint8ClampedArray, w: number, h: number) =>
    Promise<OcrWords | null>;
}
