// CJS 로더 — Node ESM 메인에서 opencv.js wasm 초기화가 이벤트 루프를 막는
// 문제를 우회한다: CJS로 cv를 먼저 초기화한 뒤 ESM 하니스 본체를 동적 import.
const cvm = require("@techstark/opencv-js");

const iv = setInterval(() => {
  if (!cvm.Mat) return;
  clearInterval(iv);
  import("./harness-main.mjs")
    .then((m) => m.main(cvm))
    .catch((e) => { console.error(e); process.exit(1); });
}, 50);
