import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIR = fileURLToPath(new URL(".", import.meta.url));

// src/pipeline/ 지문 — bench/engines.py pipeline_hash() 와 같은 계산.
// 테스트 파일은 배포 엔진에 안 실리므로 제외. 규칙을 바꾸면 양쪽을 함께 바꿀 것.
function pipelineHash() {
  const src = join(WEB_DIR, "src", "pipeline");
  const rels = [];
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (!name.endsWith(".test.ts") && !name.startsWith("__fixtures__"))
        rels.push(relative(src, p).split("\\").join("/"));
    }
  };
  walk(src);
  rels.sort();
  const h = createHash("sha256");
  for (const rel of rels) {
    h.update(rel + "\0");
    h.update(readFileSync(join(src, rel)));
    h.update("\0");
  }
  return h.digest("hex").slice(0, 12);
}

// 빌드마다 dist/version.json 을 남긴다. 배포 도구가 Space 의 이 파일을
// 읽어 로컬 엔진과 대조한다 — "엔진은 고쳤는데 재배포를 빠뜨림"(2026-08-05,
// 구엔진 오탐 45건 재판정)을 매일 자동으로 잡기 위한 장치다.
function versionStamp() {
  return {
    name: "version-stamp",
    apply: "build",
    closeBundle() {
      let git = "unknown";
      let dirty = false;
      try {
        git = execSync("git rev-parse --short HEAD", { cwd: WEB_DIR })
          .toString().trim();
        dirty = execSync("git status --porcelain -- src/pipeline",
                         { cwd: WEB_DIR }).toString().trim() !== "";
      } catch {}
      const info = {
        git, dirty,
        pipeline_hash: pipelineHash(),
        builtAt: new Date().toISOString(),
      };
      writeFileSync(join(WEB_DIR, "dist", "version.json"),
                    JSON.stringify(info) + "\n");
    },
  };
}

export default defineConfig({
  // 상대 base: Flask의 /app/ 와 HF Static Space 루트 양쪽에서 같은 빌드가 동작
  base: "./",
  plugins: [react(), versionStamp()],
  server: { host: true, allowedHosts: true },
  // 클래식 워커(iife): 모듈 워커에서는 opencv.js(emscripten) 환경 감지가
  // 실패해 wasm 초기화가 멈춘다
  worker: { format: "iife" },
  build: {
    target: "esnext",
    // opencv.js(wasm 내장)가 ~11MB — 경고만 소음이라 한도 상향
    chunkSizeWarningLimit: 20000,
  },
});
