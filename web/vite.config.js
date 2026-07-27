import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  // 상대 base: Flask의 /app/ 와 HF Static Space 루트 양쪽에서 같은 빌드가 동작
  base: "./",
  plugins: [react()],
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
