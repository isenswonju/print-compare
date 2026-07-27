import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

// 두 갈래 테스트:
//  * unit (jsdom) — canvas/worker/wasm이 필요 없는 결정론 로직·IndexedDB 계층.
//  * browser (실제 Chrome) — 진짜 canvas·pdfjs 워커가 필요한 통합 테스트
//    (PDF 600dpi 래스터화, 결과 영속화 직렬화/복원). `*.browser.test.ts`.
// 엔진(engine.ts)·컴포넌트·cv 워커의 정확성은 Node 하니스(Python 대조)가 담당.
export default defineConfig({
  test: {
    // 기본 환경 jsdom(프로젝트가 상속). browser 프로젝트는 browser 모드로 덮어씀.
    // setupFiles(fake-indexeddb/localStorage 폴리필)는 unit 전용 — 실 Chrome에는
    // 넣지 않는다(브라우저엔 진짜 IndexedDB/localStorage가 있음).
    environment: "jsdom",
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          setupFiles: ["./vitest.setup.ts"],
          include: ["src/**/*.test.ts"],
          exclude: ["src/**/*.browser.test.ts"],
        },
      },
      {
        extends: true,
        test: {
          name: "browser",
          include: ["src/**/*.browser.test.ts"],
          browser: {
            enabled: true,
            headless: true,
            // Playwright 번들 크로미움 대신 시스템 Chrome 사용(추가 다운로드 없음)
            provider: playwright({ launchOptions: { channel: "chrome" } }),
            instances: [{ browser: "chromium" }],
          },
        },
      },
    ],
    coverage: {
      provider: "v8",
      include: [
        "src/lib.ts",
        "src/cache.ts",
        "src/runner.ts",
        "src/pipeline/config.ts",
        "src/pipeline/seqmatch.ts",
        "src/pipeline/textcheck.ts",
        "src/pipeline/ocr.ts",
        "src/pipeline/pdf.ts",
      ],
    },
  },
});
