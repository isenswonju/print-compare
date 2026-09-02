# print-compare-feedback — 서버리스 피드백·원본 보관함

print-compare 앱의 외부(정적) 배포에서 피드백과 팀 공용 원본 보관함을 제공하는
Vercel Functions + Blob 백엔드.

- `POST /api/feedback` — 피드백(slim: 크롭+메타) 수집 → Blob 저장. CORS(ALLOWED_ORIGINS).
- `POST /api/admin` `{password}` — 서버에서 ADMIN_PASSWORD 대조 후에만 목록 반환.

env: `BLOB_READ_WRITE_TOKEN`(Blob 스토어 자동).
배포: `vercel deploy --prod`. 프로덕션: https://print-compare-feedback.vercel.app
