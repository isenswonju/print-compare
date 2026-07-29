// 보관함 규모 한계 측정 — 폴더·원본이 아주 많아질 때 어디서 막히는지 실제
// 크롬(진짜 IndexedDB)으로 재본다. 일상 테스트에 넣기엔 무거워서 별도 스크립트다.
//   npm run bench:library            (기본: 작은 파일 1000개 + 5MB 20개 + 폴더 200개)
//   BENCH_N=3000 npm run bench:library
//
// 재는 것
//   A. 작은 파일 대량(개수 한계)  — 저장/목록/해시집합/매니페스트 시간
//   B. 큰 파일 소량(용량 한계)    — 실제 라벨 크기의 저장·읽기 처리량
//   C. 폴더 대량 + 저장소 할당량  — 트리 규모와 브라우저가 허용하는 총량
import { createServer } from "vite";
import { chromium } from "playwright";

const N = Number(process.env.BENCH_N ?? 1000);
const SMALL_KB = Number(process.env.BENCH_KB ?? 50);
const BIG_N = Number(process.env.BENCH_BIG_N ?? 20);
const BIG_MB = Number(process.env.BENCH_BIG_MB ?? 5);
const FOLDERS = Number(process.env.BENCH_FOLDERS ?? 200);

const server = await createServer({ server: { port: 0 }, logLevel: "warn" });
await server.listen();
const url = server.resolvedUrls.local[0];

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
page.on("console", (m) => {
  if (m.text().startsWith("[bench]")) console.log(m.text());
});
await page.goto(url);

const result = await page.evaluate(async (cfg) => {
  const m = await import("/src/cache.ts");
  const now = () => performance.now();
  const log = (s) => console.log("[bench] " + s);

  // 압축이 안 되는 바이트 — 실제 이미지처럼 저장소를 그대로 차지한다.
  const fileOf = (name, bytes) => {
    const buf = new Uint8Array(bytes);
    for (let i = 0; i < bytes; i += 4096) buf[i] = i & 0xff;
    return new File([buf], name, { type: "image/png" });
  };

  const out = {};

  // A. 작은 파일 대량
  const smallHashes = Array.from({ length: cfg.N }, (_, i) => `bench-s-${i}`);
  let t = now();
  for (const h of smallHashes)
    await m.saveArtwork(h, fileOf(`${h}.png`, cfg.SMALL_KB * 1024));
  out.saveSmallMs = now() - t;

  t = now(); const arts = await m.listArtworks(); out.listMs = now() - t;
  t = now(); await m.listArtworkHashes(); out.keysMs = now() - t;
  t = now(); const man = await m.exportManifest(); out.manifestMs = now() - t;
  out.count = arts.length;
  out.manifestBytes = new Blob([JSON.stringify(man)]).size;
  log(`A. ${cfg.N}개 × ${cfg.SMALL_KB}KB — 저장 ${out.saveSmallMs.toFixed(0)}ms`);

  for (const h of smallHashes) await m.deleteArtwork(h);

  // B. 큰 파일
  const bigHashes = Array.from({ length: cfg.BIG_N }, (_, i) => `bench-b-${i}`);
  t = now();
  for (const h of bigHashes)
    await m.saveArtwork(h, fileOf(`${h}.png`, cfg.BIG_MB * 1024 * 1024));
  out.saveBigMs = now() - t;
  t = now();
  for (const h of bigHashes) {
    const b = await m.getArtworkBlob(h);
    await b.arrayBuffer();   // 서버 업로드 시 실제로 읽는 만큼 읽어본다
  }
  out.readBigMs = now() - t;
  log(`B. ${cfg.BIG_N}개 × ${cfg.BIG_MB}MB — 저장 ${out.saveBigMs.toFixed(0)}ms`);

  for (const h of bigHashes) await m.deleteArtwork(h);

  // C. 폴더 대량 + 할당량
  const ids = [];
  t = now();
  for (let i = 0; i < cfg.FOLDERS; i++) {
    // 절반은 중첩(깊이 2) — 실제 트리와 비슷한 모양으로
    const parent = i % 2 === 1 && ids.length ? ids[ids.length - 1] : undefined;
    const s = await m.createSection(`벤치폴더${i}`, parent);
    if (s) ids.push(s.id);
  }
  out.makeFoldersMs = now() - t;
  t = now(); out.folders = (await m.listSections()).length;
  out.listFoldersMs = now() - t;
  out.estimate = await m.storageEstimate();
  for (const id of ids) await m.deleteSection(id);
  log("C. 폴더 정리 완료");

  return out;
}, { N, SMALL_KB, BIG_N, BIG_MB, FOLDERS });

await browser.close();
await server.close();

const ms = (v) => `${v.toFixed(0)}ms`;
const mb = (b) => `${(b / 1024 / 1024).toFixed(1)}MB`;
const perSec = (mbTotal, msVal) => `${(mbTotal / (msVal / 1000)).toFixed(1)}MB/s`;

console.log("\n===== 보관함 규모 측정 =====");
console.log(`A. 작은 파일 ${N}개 × ${SMALL_KB}KB (총 ${mb(N * SMALL_KB * 1024)})`);
console.log(`   저장            ${ms(result.saveSmallMs)}` +
            ` (건당 ${(result.saveSmallMs / N).toFixed(2)}ms)`);
console.log(`   listArtworks    ${ms(result.listMs)}  (${result.count}건 — 화면 새로고침마다 호출)`);
console.log(`   listArtworkHashes ${ms(result.keysMs)}  (동기화가 쓰는 가벼운 경로)`);
console.log(`   exportManifest  ${ms(result.manifestMs)}  → ${mb(result.manifestBytes)} JSON`);
console.log(`B. 큰 파일 ${BIG_N}개 × ${BIG_MB}MB (총 ${BIG_N * BIG_MB}MB)`);
console.log(`   저장            ${ms(result.saveBigMs)}  ${perSec(BIG_N * BIG_MB, result.saveBigMs)}`);
console.log(`   읽기(업로드용)  ${ms(result.readBigMs)}  ${perSec(BIG_N * BIG_MB, result.readBigMs)}`);
console.log(`C. 폴더 ${FOLDERS}개`);
console.log(`   생성            ${ms(result.makeFoldersMs)}`);
console.log(`   listSections    ${ms(result.listFoldersMs)} (${result.folders}개)`);
if (result.estimate) {
  const { usage, quota, persisted } = result.estimate;
  console.log(`   저장소          ${mb(usage)} 사용 / 한도 ${mb(quota)}` +
              ` · persisted=${persisted}`);
  console.log(`   → 10MB 라벨 기준 이론 수용량 ≈ ` +
              `${Math.floor(quota / (10 * 1024 * 1024)).toLocaleString()}개`);
}
