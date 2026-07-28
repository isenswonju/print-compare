// 인쇄 검수 브라우저판 — 분석은 전부 접속자 브라우저 안에서 실행된다.
// 검수(업로드) / 결과 페이지를 상단 GNB로 전환. 결과는 좌측 세트 목록 +
// 우측 상세(마스터-디테일). 다중 세트는 메모리가 허용하면 동시 2세트 병렬.
import React, { useEffect, useRef, useState } from "react";
import { clearSession, createSection, deleteArtwork, deleteSection,
         exportLibrary, getArtworkFile, hashFile, importLibrary, listArtworks,
         listSections, loadSession, renameSection, requestPersistentStorage,
         saveArtwork, saveSession, setArtworkSection, type ArtworkEntry,
         type LibraryBackup, type Section, type StoredSet } from "./cache.ts";
import { MultiDropZone, FeedbackModal, ResultDetail,
         type ModalState } from "./components.tsx";
import { applySetName, buildFeedbackPayload, download, feedbackCsv, flushFbQueue,
         fmtDateTime, fmtMB, hasFeedbackEndpoint, loadFbQueue, restoreResults,
         saveFbQueue, serializeResults, slimPayload,
         trySendFeedback } from "./lib.ts";
import { hasLibraryServer, pullLibraryFromServer,
         pushLibraryToServer } from "./server-library.ts";
import { runAll, type RunSet } from "./runner.ts";
import { ensureRasterPages } from "./pipeline/pdf.ts";
import { branding } from "./branding.ts";
import type { FileEntry, ResultItem, SetFb } from "./types.ts";

// 세트 = 한 품목. 원본/인쇄물 각각 여러 파일(각 파일은 PDF면 여러 페이지)을
// 받아 페이지 목록으로 펼친다. 양쪽 총 페이지 수가 같아야 검수를 시작할 수 있다.
interface Pair { id: number; ref: FileEntry[]; test: FileEntry[]; name?: string; }

const pageCount = (side: FileEntry[]) =>
  side.reduce((s, e) => s + e.pages.length, 0);
const flatPages = (side: FileEntry[]) => side.flatMap((e) => e.pages);

let pairSeq = 0;

export default function App() {
  const [view, setView] = useState<"upload" | "results" | "admin">("upload");
  // 관리자(피드백 조회) — 비번은 앱에 저장하지 않고 수집기 서버가 대조.
  const [adminOpen, setAdminOpen] = useState(false);
  const [adminPw, setAdminPw] = useState("");
  const [adminErr, setAdminErr] = useState("");
  const [adminBusy, setAdminBusy] = useState(false);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const [adminData, setAdminData] = useState<{ count: number; items: any[] } | null>(null);
  const authedPwRef = useRef("");  // 로그인 후 목록 새로고침에 재사용(메모리만)
  const [pairs, setPairs] = useState<Pair[]>(
    [{ id: ++pairSeq, ref: [], test: [] }]);
  const [useOcr, setUseOcr] = useState(true);
  const [running, setRunning] = useState(false);
  const [stages, setStages] = useState<Record<number, string>>({});
  const [error, setError] = useState("");
  const [logs, setLogs] = useState<string[]>([]);
  const [elapsed, setElapsed] = useState(0);
  const [results, setResults] = useState<ResultItem[]>([]);
  const [selected, setSelected] = useState(0);
  const [fbStatus, setFbStatus] = useState("");
  const [sendingIdx, setSendingIdx] = useState<number | null>(null);
  const [modal, setModalState] =
    useState<{ idx: number; m: ModalState } | null>(null);
  const [recent, setRecent] = useState<ArtworkEntry[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  // 기본은 닫힘 — 펼친 섹션 id만 담는다(빈 상태 = 전부 닫힘).
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // 선택(눌린) 섹션 — 이 상태에서 ＋섹션을 누르면 하위 섹션이 여기에 생긴다.
  const [selectedSection, setSelectedSection] = useState<string | null>(null);
  const [addingSection, setAddingSection] = useState(false);
  const [sectionDraft, setSectionDraft] = useState("");
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [libStatus, setLibStatus] = useState(""); // 백업/복원 안내
  const [hoverTip, setHoverTip] = useState(""); // 백업/복원 버튼 호버 설명
  const libImportRef = useRef<HTMLInputElement>(null);
  // 서버 보관함 동기화 — 비번 입력 프롬프트 상태
  const [serverAct, setServerAct] = useState<"push" | "pull" | null>(null);
  const [serverPw, setServerPw] = useState("");
  const [serverBusy, setServerBusy] = useState(false);
  const [dragOverSec, setDragOverSec] = useState<string | null>(null);
  const [editingSet, setEditingSet] = useState<number | null>(null); // 이름 편집 중인 setId
  const [restored, setRestored] = useState(false);
  // 분석 수행 시각 — 결과가 7일 보존되므로 언제 분석한 것인지 표시한다
  const [analyzedAt, setAnalyzedAt] = useState<number | null>(null);
  // PDF 변환 중인 드롭존 키(`id:ref`/`id:test`) — 변환 끝날 때까지 검수 시작 차단
  const [converting, setConverting] = useState<Record<string, boolean>>({});
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 저장된 세션 스냅샷 — 피드백만 바뀔 때 이미지 재직렬화를 피하려고 들고 있는다
  const storedRef = useRef<StoredSet[] | null>(null);
  const analyzedAtRef = useRef<number | null>(null); // 재저장 시 분석 시각 유지

  const pushLog = (m: string) => setLogs((l) => [...l, m]);

  // 보관함(아트웍 + 섹션) 새로고침
  const refreshLibrary = () =>
    Promise.all([listArtworks(), listSections()]).then(([a, s]) => {
      setRecent(a); setSections(s);
    });

  // 파일 추가: 각 파일을 페이지 PNG로 펼쳐(PDF면 여러 장) 세트의 해당 면에
  // 누적한다. 같은 이름은 제자리에서 덮어쓰고, 새로 온 파일은 이름순으로만
  // 정렬해 뒤에 붙인다 — 기존(수동 정렬했을 수도 있는) 순서를 보존하면서
  // 첫 업로드는 원본↔인쇄물이 이름순으로 자연 매칭되게 한다.
  // setName: 보관함에서 투입할 때만 넘어옴(그 파일이 속한 섹션 이름).
  const addFiles = async (id: number, which: "ref" | "test", files: File[],
                          setName?: string) => {
    const key = `${id}:${which}`;
    setConverting((c) => ({ ...c, [key]: true }));
    setError("");
    try {
      const newEntries: FileEntry[] = [];
      for (const file of files) {
        const pages = await ensureRasterPages(file, undefined, pushLog);
        newEntries.push({ name: file.name, file, pages });
      }
      newEntries.sort((a, b) => a.name.localeCompare(b.name, "ko"));
      setPairs((ps) => ps.map((p) => {
        if (p.id !== id) return p;
        const map = new Map(p[which].map((e) => [e.name, e]));
        for (const e of newEntries) map.set(e.name, e); // 기존은 제자리 덮어쓰기
        const merged = [...map.values()];
        return { ...p, [which]: merged,
                 name: setName !== undefined ? setName : p.name };
      }));
      // 원본 파일은 보관함에 영구 저장(원본 그대로 — 재사용 시 재래스터화).
      if (which === "ref") {
        for (const e of newEntries)
          hashFile(e.file).then((h) => saveArtwork(h, e.file)).catch(() => {});
        refreshLibrary();
      }
    } catch (err) {
      setError(`파일 처리 실패: ` + String((err as Error).message || err));
    } finally {
      setConverting((c) => { const n = { ...c }; delete n[key]; return n; });
    }
  };
  const removeEntry = (id: number, which: "ref" | "test", name: string) =>
    setPairs((ps) => ps.map((p) =>
      p.id === id ? { ...p, [which]: p[which].filter((e) => e.name !== name) } : p));
  // 세트 안 파일 순서를 드래그로 바꾼다(원본/인쇄물 페이지 매칭을 수동 조정).
  const reorderEntry = (id: number, which: "ref" | "test",
                        from: number, to: number) =>
    setPairs((ps) => ps.map((p) => {
      if (p.id !== id) return p;
      const arr = [...p[which]];
      const [m] = arr.splice(from, 1);
      arr.splice(to, 0, m);
      return { ...p, [which]: arr };
    }));
  // 보관함 아트웍을 세트에 드래그 투입 — 그 파일이 속한 섹션 이름으로 세트명
  // 을 바꾼다(미분류면 기본값 유지). 원본 면에 넣을 때만 세트명을 반영한다.
  const addArtworkToPair = async (
    id: number, which: "ref" | "test", hash: string) => {
    const f = await getArtworkFile(hash);
    if (!f) return;
    const art = recent.find((a) => a.hash === hash);
    const sec = art?.section && sections.find((s) => s.id === art.section);
    // 원본에 투입 시: 섹션명으로 세트명 지정, 미분류면 ""(→ 기본 "세트 N")로 리셋.
    const setName = which === "ref" ? (sec ? sec.name : "") : undefined;
    await addFiles(id, which, [f], setName);
  };
  const anyConverting = Object.values(converting).some(Boolean);
  const addPair = () =>
    setPairs((ps) => [...ps, { id: ++pairSeq, ref: [], test: [] }]);
  const removePair = (id: number) =>
    setPairs((ps) => (ps.length > 1 ? ps.filter((p) => p.id !== id) : ps));
  const updateFb = (index: number) => (updater: (cur: SetFb) => SetFb) =>
    setResults((rs) => rs.map((it, i) => {
      if (i !== index) return it;
      const fb = updater(it.fb || { defects: {}, missed: [] });
      // 피드백도 보존 — 이미지는 그대로 두고 메타데이터만 갱신
      const stored = storedRef.current;
      if (stored?.[index]) {
        stored[index] = { ...stored[index], fb };
        saveSession(stored, analyzedAtRef.current ?? Date.now());
      }
      return { ...it, fb };
    }));

  // 보관함 로드 + 보류 피드백 자동 재전송 + 지난 결과 복원
  useEffect(() => {
    document.title = branding.name;
    // 보관함 유실 1차 방어 — 저장소를 'persistent'로 승격 요청(자동 삭제 방지).
    requestPersistentStorage();
    refreshLibrary();
    flushFbQueue().then((n) => {
      if (n) setFbStatus(`보관 중이던 피드백 ${n}건을 서버로 전송했습니다.`);
    });
    loadSession().then(async (rec) => {
      if (!rec?.sets?.length) return;
      storedRef.current = rec.sets;
      analyzedAtRef.current = rec.analyzedAt;
      setAnalyzedAt(rec.analyzedAt);
      setResults(await restoreResults(rec.sets));
      setRestored(true);
    });
  }, []);

  async function discardResults() {
    await clearSession();
    storedRef.current = null;
    analyzedAtRef.current = null;
    setAnalyzedAt(null);
    setResults([]);
    setRestored(false);
    setSelected(0);
    setView("upload");
  }

  // 보관함에서 아트웍 클릭: 원본이 빈 첫 세트에 투입, 없으면 새 세트 생성.
  // 세트명은 그 파일의 섹션 이름으로 맞춘다(미분류면 기본값). PDF는 펼친다.
  const applyArtwork = async (hash: string) => {
    let target = pairs.find((p) => p.ref.length === 0)?.id;
    if (target === undefined) {
      target = ++pairSeq;
      setPairs((ps) => [...ps, { id: target!, ref: [], test: [] }]);
    }
    await addArtworkToPair(target, "ref", hash);
  };

  // 보관함 섹션(폴더) 관리 — 선택된 상위 섹션이 있으면 그 아래에 만든다.
  const onAddSection = async () => {
    const name = sectionDraft.trim();
    const parent = selectedSection ?? undefined;
    setAddingSection(false); setSectionDraft("");
    if (name) {
      await createSection(name, parent);
      if (parent) setExpanded((x) => ({ ...x, [parent]: true })); // 부모 펼쳐 보이기
      refreshLibrary();
    }
  };
  const onRenameSection = async (id: string, name: string) => {
    setEditingSection(null);
    if (name.trim()) { await renameSection(id, name.trim()); refreshLibrary(); }
  };
  const onDeleteSection = async (id: string) => {
    await deleteSection(id);
    setSelectedSection((cur) => (cur === id ? null : cur));
    refreshLibrary();
  };
  const onDeleteArtwork = async (hash: string) => {
    await deleteArtwork(hash); refreshLibrary();
  };
  const onSetSection = async (hash: string, section: string) => {
    await setArtworkSection(hash, section || undefined); refreshLibrary();
  };

  // 보관함 백업/복원(안 C) — 서버 없이도 유실에 대비하는 최소 안전망.
  const onExportLibrary = async () => {
    setLibStatus("백업 파일 만드는 중…");
    try {
      const backup = await exportLibrary();
      const stamp = fmtDateTime(backup.exportedAt).replace(/[^\d]/g, "");
      download(`보관함백업_${stamp}.json`,
        new Blob([JSON.stringify(backup)], { type: "application/json" }));
      setLibStatus(`백업 완료 — 아트웍 ${backup.artworks.length}개 · ` +
        `섹션 ${backup.sections.length}개`);
    } catch (e) {
      setLibStatus("백업 실패: " + String((e as Error).message || e));
    }
  };
  const onImportLibrary = async (file: File) => {
    setLibStatus("복원 중…");
    try {
      const backup = JSON.parse(await file.text()) as LibraryBackup;
      const r = await importLibrary(backup); // 병합(기존에 더함)
      await refreshLibrary();
      setLibStatus(`복원 완료 — 아트웍 ${r.artworks}개 · 섹션 ${r.sections}개 반영`);
    } catch (e) {
      setLibStatus("복원 실패: " + String((e as Error).message || e));
    }
  };

  // 서버 보관함 동기화(안 A) — 비번 확인 후 업로드/불러오기.
  const runServerSync = async () => {
    const act = serverAct, pw = serverPw;
    setServerAct(null); setServerPw("");
    if (!act || !pw) return;
    setServerBusy(true);
    setLibStatus(act === "push" ? "서버로 백업 중…" : "서버에서 불러오는 중…");
    try {
      if (act === "push") {
        const r = await pushLibraryToServer(pw);
        setLibStatus(`서버 백업 완료 — 아트웍 ${r.artworks}개 · 섹션 ${r.sections}개`);
      } else {
        const r = await pullLibraryFromServer(pw);
        if (!r) { setLibStatus("서버에 저장된 백업이 아직 없습니다."); return; }
        await refreshLibrary();
        setLibStatus(`서버에서 불러옴 — 아트웍 ${r.artworks}개 · 섹션 ${r.sections}개 반영`);
      }
    } catch (e) {
      setLibStatus((act === "push" ? "서버 백업 실패: " : "불러오기 실패: ") +
        String((e as Error).message || e));
    } finally {
      setServerBusy(false);
    }
  };

  // 백업/복원 버튼 호버·포커스 시 간단한 설명을 아래 안내 박스로 보여준다
  // (좁은 사이드바 + overflow 클리핑 때문에 떠 있는 툴팁 대신 인라인 박스).
  const tip = (t: string) => ({
    onMouseEnter: () => setHoverTip(t),
    onMouseLeave: () => setHoverTip((c) => (c === t ? "" : c)),
    onFocus: () => setHoverTip(t),
    onBlur: () => setHoverTip((c) => (c === t ? "" : c)),
  });

  // 보관함 아트웍 한 행: 클릭해 투입 + 드래그해서 섹션 이동 + 삭제.
  const renderArtwork = (a: ArtworkEntry) => (
    <div className="artitem-row" key={a.hash} draggable={!running}
         onDragStart={(e) => {
           e.dataTransfer.setData("text/hash", a.hash);
           e.dataTransfer.effectAllowed = "move";
         }}>
      <span className="art-grip" title="드래그해서 섹션으로 이동">⠿</span>
      <button type="button" className="artitem" disabled={running}
              title={`${a.name} (${fmtMB(a.size)}) — 클릭해서 원본에 투입`}
              onClick={() => applyArtwork(a.hash)}>
        <span className="artname">{a.name}</span>
        <span className="artsize">{fmtMB(a.size)}</span>
      </button>
      <button type="button" className="art-del" disabled={running}
              title="보관함에서 삭제" onClick={() => onDeleteArtwork(a.hash)}>✕</button>
    </div>
  );
  // 드롭 대상(섹션/미분류) 공통 핸들러. 중첩 섹션에서 부모로 버블링되지 않게
  // stopPropagation — 가장 안쪽(놓은) 섹션에만 배정된다.
  const dropProps = (sectionId: string) => ({
    onDragOver: (e: React.DragEvent) => {
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      setDragOverSec(sectionId);
    },
    onDragLeave: () => setDragOverSec((s) => (s === sectionId ? null : s)),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault(); e.stopPropagation();
      const hash = e.dataTransfer.getData("text/hash");
      setDragOverSec(null);
      if (hash) onSetSection(hash, sectionId);
    },
  });

  // 섹션(폴더) 재귀 렌더 — 기본 닫힘, 선택된 상위 섹션은 강조.
  // depth로 들여쓰기. 자식 섹션은 부모가 펼쳐졌을 때만 보인다.
  const renderSection = (s: Section, depth: number): React.ReactNode => {
    const arts = recent.filter((a) => a.section === s.id);
    const children = sections.filter((c) => c.parentId === s.id);
    const isOpen = !!expanded[s.id];
    const isSel = selectedSection === s.id;
    return (
      <div className={"sec-group" + (dragOverSec === s.id ? " dragover" : "")}
           key={s.id} {...dropProps(s.id)}>
        <div className={"sec-head" + (isSel ? " selected" : "")}
             style={{ paddingLeft: depth * 14 }}>
          <button type="button" className="sec-toggle"
                  onClick={() => setExpanded((x) => ({ ...x, [s.id]: !x[s.id] }))}
                  title={isOpen ? "접기" : "펼치기"}>
            {isOpen ? "▾" : "▸"}
          </button>
          {editingSection === s.id ? (
            <input autoFocus defaultValue={s.name}
              onBlur={(e) => onRenameSection(s.id, e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") onRenameSection(s.id, e.currentTarget.value);
                if (e.key === "Escape") setEditingSection(null);
              }} />
          ) : (
            <span className="sec-name"
                  title="클릭: 선택(여기에 하위 섹션 추가) · 더블클릭: 이름 변경"
                  onClick={() => !running &&
                    setSelectedSection((cur) => (cur === s.id ? null : s.id))}
                  onDoubleClick={() => !running && setEditingSection(s.id)}>
              {s.name} <span className="sec-count">{arts.length}</span>
              {children.length > 0 &&
                <span className="sec-count">· {children.length}폴더</span>}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="sec-btn" title="하위 섹션 추가"
                  disabled={running}
                  onClick={() => {
                    setSelectedSection(s.id);
                    setExpanded((x) => ({ ...x, [s.id]: true }));
                    setAddingSection(true);
                  }}>＋</button>
          <button type="button" className="sec-btn" title="이름 변경"
                  disabled={running}
                  onClick={() => setEditingSection(s.id)}>✎</button>
          <button type="button" className="sec-btn" title="섹션 삭제(원본은 미분류로)"
                  disabled={running}
                  onClick={() => onDeleteSection(s.id)}>🗑</button>
        </div>
        {isOpen && (
          <>
            {arts.map(renderArtwork)}
            {arts.length === 0 && children.length === 0 && (
              <div className="sec-empty">여기로 드래그해 정리하세요</div>
            )}
            {children.map((c) => renderSection(c, depth + 1))}
          </>
        )}
      </div>
    );
  };

  // 세트가 완성되려면 원본·인쇄물 모두 1장 이상이고 총 페이지 수가 같아야 한다.
  const pairComplete = (p: Pair) =>
    pageCount(p.ref) > 0 && pageCount(p.ref) === pageCount(p.test);
  const completePairs = pairs.filter(pairComplete);
  // 모든 세트가 완성돼야 검수 시작 가능. 페이지 수 불일치 세트가 있으면 안내.
  const allComplete = pairs.length > 0 && completePairs.length === pairs.length;
  const mismatch = pairs.some((p) =>
    pageCount(p.ref) > 0 && pageCount(p.test) > 0 &&
    pageCount(p.ref) !== pageCount(p.test));

  async function run() {
    setRunning(true);
    setError("");
    setLogs([]);
    setResults([]);
    setStages({});
    setSelected(0);
    setRestored(false);
    setAnalyzedAt(null);
    storedRef.current = null;
    analyzedAtRef.current = null;
    clearSession();
    const t0 = performance.now();
    timerRef.current = setInterval(
      () => setElapsed(Math.round((performance.now() - t0) / 1000)), 1000);
    let ok = 0;
    try {
      const sets: RunSet[] = completePairs.map((p, i) => ({
        setId: p.id,
        // 세트 이름: 보관함 섹션명이 반영됐으면 그 이름, 아니면 기본값.
        name: p.name?.trim() || `세트 ${i + 1}`,
        refPages: flatPages(p.ref),
        testPages: flatPages(p.test),
      }));
      await runAll(
        sets,
        useOcr,
        {
          log: pushLog,
          stage: (slot, s) => setStages((st) => {
            const next = { ...st };
            if (s === null) delete next[slot];
            else next[slot] = s;
            return next;
          }),
          onResult: (index, item) => {
            if (!item.error) ok++;
            setResults((r) => {
              const next = [...r];
              next[index] = item;
              return next;
            });
          },
        });
    } catch (err) {
      setError(String((err as Error).message || err));
    } finally {
      if (timerRef.current) clearInterval(timerRef.current);
      setRunning(false);
      refreshLibrary();
    }
    if (ok || completePairs.length) setView("results");
    // 결과 보존 — 새로고침·재방문 후에도 이어서 볼 수 있게. 분석 시각도 함께 남긴다.
    const at = Date.now();
    analyzedAtRef.current = at;
    setAnalyzedAt(at);
    setResults((rs) => {
      serializeResults(rs).then((sets) => {
        storedRef.current = sets;
        saveSession(sets, at);
      });
      return rs;
    });
  }

  // 세트 단위 피드백 전송 (사이드바의 세트 컴포넌트 안에서 호출)
  async function sendFeedbackFor(idx: number) {
    const item = results[idx];
    if (!item) return;
    setSendingIdx(idx);
    const setStatus = (msg: string) =>
      setResults((rs) => rs.map((it, i) =>
        i === idx ? { ...it, fbStatus: msg } : it));
    const saveAsFile = (payload: object) => {
      download(`feedback_${Date.now()}.json`, new Blob(
        [JSON.stringify(payload)], { type: "application/json" }));
      setStatus("파일로 저장됨 — 품질 담당자에게 전달해주세요.");
    };
    try {
      const payload = await buildFeedbackPayload([item]);
      // 수집기에는 slim(결함 크롭+메타)만 보낸다 — 전체 라벨 원본은
      // 브라우저 밖으로 내보내지 않는다.
      const slim = slimPayload(payload);
      // 수집기 경로가 없으면(엔드포인트 미설정) 파일 저장 안내
      if (!hasFeedbackEndpoint) {
        saveAsFile(slim);
        return;
      }
      const url = await trySendFeedback(slim);
      if (url) {
        setStatus("전송 완료 ✓");
        return;
      }
      // 수집기 연결 불가 — 브라우저에 보관했다가 다음 방문 때 자동 재전송.
      // 보관도 실패하면 파일로 저장.
      const q = loadFbQueue();
      q.push(slim);
      if (saveFbQueue(q))
        setStatus("서버 연결 불가 — 브라우저에 보관됨, 다음 방문 시 자동 전송");
      else saveAsFile(slim);
    } finally {
      setSendingIdx(null);
    }
  }

  // 관리자 조회 — 비번을 수집기 서버로 보내 대조한 뒤 목록을 받아온다.
  async function submitAdmin(e?: React.FormEvent, pw?: string) {
    e?.preventDefault();
    const adminUrl = branding.feedback?.adminUrl;
    if (!adminUrl) return;
    // 로그인 시엔 입력값(adminPw), 목록 새로고침 시엔 인증된 비번(ref) 사용.
    const password = pw ?? adminPw;
    if (!password) return;
    setAdminBusy(true);
    setAdminErr("");
    try {
      const r = await fetch(adminUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      if (r.status === 401) { setAdminErr("비밀번호가 올바르지 않습니다."); return; }
      if (!r.ok) { setAdminErr(`오류: ${r.status}`); return; }
      const data = await r.json();
      authedPwRef.current = password;   // 세션 동안만 메모리에 보관(비저장)
      setAdminData(data);
      setAdminOpen(false);
      setAdminPw("");
      setView("admin");
    } catch {
      setAdminErr("수집기에 연결할 수 없습니다.");
    } finally {
      setAdminBusy(false);
    }
  }

  // 피드백 모달 저장/삭제 — 사이드바·상세 어디에서 열었든 여기서 처리
  const saveModal = (v: { fp: boolean; cause: string; comment: string }) => {
    if (!modal) return;
    const m = modal.m;
    const apply = updateFb(modal.idx);
    if (m.kind === "defect") {
      apply((cur) => ({
        ...cur,
        defects: { ...cur.defects,
          [m.f.id]: { fp: v.fp, cause: v.cause, comment: v.comment,
                      ktype: m.f.disp.ktype, bbox: m.f.bbox_ref } },
      }));
    } else if (m.idx != null) {
      const mi = m.idx;
      apply((cur) => ({
        ...cur,
        missed: cur.missed.map((mm, i) =>
          i === mi ? { ...mm, cause: v.cause, comment: v.comment } : mm),
      }));
    } else {
      apply((cur) => ({
        ...cur,
        missed: [...cur.missed,
                 { x: m.x, y: m.y, cause: v.cause, comment: v.comment }],
      }));
    }
    setModalState(null);
  };
  const deleteMissed = () => {
    if (!modal || modal.m.kind !== "missed" || modal.m.idx == null) return;
    const mi = modal.m.idx;
    updateFb(modal.idx)((cur) => ({
      ...cur,
      missed: cur.missed.filter((_, i) => i !== mi),
    }));
    setModalState(null);
  };

  const loaded = results.filter(Boolean);
  const done = loaded.filter((r) => !r.error);
  const totalDefects = done.reduce((s, r) => s + (r.defects?.length ?? 0), 0);
  const hasFeedback = loaded.some((r) => r.fb &&
    (Object.keys(r.fb.defects).length || r.fb.missed.length));
  const stageText = Object.entries(stages)
    .sort(([a], [b]) => +a - +b).map(([, s]) => s).join(" · ");

  // 페이지 결과를 세트(품목)별로 묶는다 — 한 세트 안에서 여러 페이지를 표시.
  const groups: { setId: number; name: string;
                  items: { item: ResultItem; gi: number }[] }[] = [];
  loaded.forEach((item, gi) => {
    let g = groups.find((x) => x.setId === item.setId);
    if (!g) { g = { setId: item.setId, name: item.name, items: [] }; groups.push(g); }
    g.items.push({ item, gi });
  });
  const setCount = groups.length;

  // 세트 이름 변경 — 해당 세트의 모든 페이지에 반영하고 세션에도 보존.
  const renameSet = (setId: number, name: string) => {
    setEditingSet(null);
    const nm = name.trim();
    if (!nm) return;
    setResults((rs) => applySetName(rs, setId, nm));
    const stored = storedRef.current;
    if (stored) {
      storedRef.current = stored.map((s) => (s.setId === setId ? { ...s, name: nm } : s));
      saveSession(storedRef.current, analyzedAtRef.current ?? Date.now());
    }
  };

  // 세트 이름 라벨(편집 가능) — 더블클릭 또는 ✎ 버튼으로 편집. 부모가 <div>여야
  // 함(버튼/인풋 중첩 방지). title로 원본 파일명 노출.
  const renderSetLabel = (setId: number, label: string, fileName?: string) =>
    editingSet === setId ? (
      <input className="set-rename" autoFocus defaultValue={label}
        onClick={(e) => e.stopPropagation()}
        onBlur={(e) => renameSet(setId, e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter") renameSet(setId, e.currentTarget.value);
          if (e.key === "Escape") setEditingSet(null);
        }} />
    ) : (
      <span className="setname editable" title={fileName}
            onDoubleClick={(e) => { e.stopPropagation(); setEditingSet(setId); }}>
        <span className="setname-text">{label}</span>
        <button type="button" className="set-edit" title="이름 변경"
                onClick={(e) => { e.stopPropagation(); setEditingSet(setId); }}>✎</button>
      </span>
    );

  // 한 페이지 결과 항목(헤드 + 피드백 상세 + 전송). multi면 "페이지 N"으로 표기.
  const renderPageItem = (item: ResultItem, gi: number, multi: boolean) => {
    const nDef = item.defects?.length ?? 0;
    const rIdx = results.indexOf(item);
    const fbEntries: { key: string; badge: string; badgeCls: string;
                       label: string; comment: string; m: ModalState }[] = [];
    if (item.defects && item.fb) {
      for (const [id, v] of Object.entries(item.fb.defects)) {
        const f = item.defects.find((d) => d.id === +id);
        if (f) fbEntries.push({
          key: "d" + id, badge: v.fp ? "☑ 오탐" : "☐ 의견",
          badgeCls: "fbbadge" + (v.fp ? " fp" : ""),
          label: `#${id} ${v.ktype}`, comment: v.comment,
          m: { kind: "defect", f },
        });
      }
      item.fb.missed.forEach((mm, mi) => fbEntries.push({
        key: "m" + mi, badge: "미검출", badgeCls: "fbbadge miss",
        label: `M${mi + 1}`, comment: mm.comment,
        m: { kind: "missed", x: mm.x, y: mm.y, idx: mi },
      }));
    }
    const badge = item.error
      ? <span className="badge err-badge">실패</span>
      : nDef ? <span className="badge bad-badge">결함 {nDef}</span>
        : <span className="badge ok-badge">정상</span>;
    return (
      <div key={item.setId + "-" + item.page}
           className={"setitem" + (gi === selected ? " on" : "") + (multi ? " page" : "")}>
        <div className="sethead" role="button" tabIndex={0}
             onClick={() => setSelected(gi)}
             onKeyDown={(e) => {
               if (e.key === "Enter" || e.key === " ") {
                 e.preventDefault(); setSelected(gi);
               }
             }}>
          <span className="sethead-main">
            {multi
              ? <span className="setname">페이지 {item.page}</span>
              : renderSetLabel(item.setId, item.name, item.refFile?.name)}
            {!multi && analyzedAt && (
              <span className="setdate">{fmtDateTime(analyzedAt)}</span>)}
          </span>
          {badge}
        </div>
        {fbEntries.map((e) => (
          <button type="button" key={e.key} className="fbrow"
                  onClick={() => { setSelected(gi); setModalState({ idx: rIdx, m: e.m }); }}>
            <span className={e.badgeCls}>{e.badge}</span>
            <span className="fbrow-label">{e.label}</span>
            <span className="fbrow-comment">{e.comment}</span>
          </button>
        ))}
        {fbEntries.length > 0 && (
          <div className="fbsend">
            <button type="button" className="go save" disabled={sendingIdx === rIdx}
                    onClick={() => sendFeedbackFor(rIdx)}>
              {sendingIdx === rIdx ? "전송 중…" : "피드백 전송"}
            </button>
            {item.fbStatus && <span className="note">{item.fbStatus}</span>}
          </div>
        )}
      </div>
    );
  };

  const gnb = (
    <nav className="gnb">
      <div className="gnb-inner">
        <a href="#" className="brand" title="검수 페이지로"
           onClick={(e) => { e.preventDefault(); setView("upload"); }}>
          {branding.logo
            ? <img className="brand-logo" src={branding.logo} alt={branding.name} />
            : branding.wordmark.map((p, i) => (
                <span key={i} style={{ color: p.color }}>{p.text}</span>
              ))}
        </a>
        <a href="#" className={view === "upload" ? "on" : ""}
           onClick={(e) => { e.preventDefault(); setView("upload"); }}>검수</a>
        <a href="#" className={view === "results" ? "on" : ""}
           onClick={(e) => { e.preventDefault(); setView("results"); }}>
          결과{setCount ? ` (${setCount})` : ""}</a>
        {running && (
          <span className="gnb-status">
            <span className="spin" />{stageText || "분석 중"} · {elapsed}초
          </span>
        )}
        {branding.feedback?.adminUrl && (
          <button className="gnb-admin" title="관리자 — 피드백 조회"
                  onClick={() => { setAdminErr(""); setAdminOpen(true); }}>🔒</button>
        )}
      </div>
    </nav>
  );

  // 관리자 로그인 모달 — 비번은 상태에만, 앱 번들에 저장하지 않는다.
  const adminModal = adminOpen && (
    <div className="modal-back" onClick={() => setAdminOpen(false)}>
      <form className="modal admin-modal" onClick={(e) => e.stopPropagation()}
            onSubmit={submitAdmin}>
        <h3>관리자 로그인</h3>
        <p className="admin-hint">피드백 조회를 위해 비밀번호를 입력하세요.</p>
        <input className="admin-pw" type="password" autoFocus
               placeholder="비밀번호" value={adminPw}
               onChange={(e) => setAdminPw(e.target.value)} />
        {adminErr && <p className="admin-err">{adminErr}</p>}
        <div className="modal-btns">
          <span style={{ flex: 1 }} />
          <button type="button" className="rm"
                  onClick={() => setAdminOpen(false)}>취소</button>
          <button type="submit" className="go save" disabled={adminBusy}>
            {adminBusy ? "확인 중…" : "로그인"}</button>
        </div>
      </form>
    </div>
  );

  // 수집된 피드백 1건(제출 단위) 렌더 — 세트별 결함/누락과 크롭 이미지.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const renderAdminEntry = (entry: any, i: number) => {
    const data = entry?.data ?? {};
    const when = entry?.received || entry?.uploadedAt;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sets: any[] = Array.isArray(data.items) ? data.items : [];
    return (
      <div className="admin-entry" key={entry?.pathname || i}>
        <div className="admin-entry-head">
          <b>{when ? new Date(when).toLocaleString("ko-KR") : "시간 미상"}</b>
          <span className="admin-origin">{entry?.origin || data.origin || ""}</span>
          <span className="admin-ver">v{data.version || "?"}</span>
        </div>
        {sets.map((s, si) => {
          const fb = s?.feedback ?? {};
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const defects: any[] = Array.isArray(fb.defects) ? fb.defects : [];
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const missed: any[] = Array.isArray(fb.missed) ? fb.missed : [];
          return (
            <div className="admin-set" key={si}>
              <div className="admin-set-name">{s?.set || `세트 ${si + 1}`}</div>
              {defects.map((d, di) => (
                <div className="admin-fb" key={`d${di}`}>
                  <span className={`admin-tag ${d.fp ? "fp" : "tp"}`}>
                    {d.fp ? "오탐" : "정탐"}</span>
                  <span className="admin-ktype">{d.ktype || d.type || "결함"}</span>
                  {d.cause && <span className="admin-cause">· {d.cause}</span>}
                  {d.comment && <span className="admin-comment">“{d.comment}”</span>}
                  {d.refCrop && <img className="admin-crop" src={d.refCrop} alt="원본" />}
                  {d.testCrop && <img className="admin-crop" src={d.testCrop} alt="인쇄물" />}
                </div>
              ))}
              {missed.map((m, mi) => (
                <div className="admin-fb" key={`m${mi}`}>
                  <span className="admin-tag miss">미검출</span>
                  {m.comment && <span className="admin-comment">“{m.comment}”</span>}
                  {m.refCrop && <img className="admin-crop" src={m.refCrop} alt="원본" />}
                  {m.testCrop && <img className="admin-crop" src={m.testCrop} alt="인쇄물" />}
                </div>
              ))}
              {!defects.length && !missed.length && (
                <div className="admin-empty-set">표시할 항목 없음</div>
              )}
            </div>
          );
        })}
      </div>
    );
  };

  // ---------------------------------------------------------------- 관리자 페이지
  if (view === "admin") {
    const items = adminData?.items ?? [];
    return (
      <>
        {gnb}
        {adminModal}
        <div className="shell admin-shell">
          <div className="admin-head">
            <h2>수집된 피드백 <span className="admin-count">{adminData?.count ?? items.length}건</span></h2>
            <div className="admin-head-actions">
              <button className="rm"
                      onClick={() => submitAdmin(undefined, authedPwRef.current)}
                      disabled={adminBusy}>새로고침</button>
              <button className="rm" onClick={() => setView("upload")}>닫기</button>
            </div>
          </div>
          {items.length === 0
            ? <p className="admin-empty">아직 수집된 피드백이 없습니다.</p>
            : items.map(renderAdminEntry)}
        </div>
      </>
    );
  }

  // ---------------------------------------------------------------- 결과 페이지
  if (view === "results") {
    const sel = loaded[selected] ?? loaded[0];
    return (
      <>
        {gnb}
        {adminModal}
        <div className="shell">
          {loaded.length === 0 ? (
            <p className="note">아직 분석 결과가 없습니다. 검수 탭에서 이미지를
              올리고 검수를 시작하세요.</p>
          ) : (
            <>
              <div className="top">
                <p className="summary" style={{ margin: 0 }}>
                  {setCount}세트 · {loaded.length}페이지 분석 — 총 결함{" "}
                  {totalDefects
                    ? <b className="bad">{totalDefects}건</b>
                    : <b className="ok">0건</b>}
                  {loaded.some((r) => r.error) &&
                    <span className="err"> · 실패 {loaded.filter((r) => r.error).length}페이지</span>}
                </p>
                <span className="topactions">
                  {hasFeedback && (
                    <a href="#" className="note" onClick={(e) => { e.preventDefault();
                      download("feedback.csv", new Blob([feedbackCsv(loaded)],
                        { type: "text/csv" })); }}>피드백 CSV 저장</a>
                  )}
                  <button type="button" className="rm" onClick={discardResults}>
                    결과 지우기
                  </button>
                </span>
              </div>
              {analyzedAt && (
                <p className="note">
                  {fmtDateTime(analyzedAt)} 분석{restored ? " · 이전 결과" : ""}
                  {" · "}이 브라우저에만 7일간 보관
                </p>
              )}
              {fbStatus && <p className="note">{fbStatus}</p>}
              <div className="results">
                <aside className="setlist">
                  {groups.map((g) => {
                    const multi = g.items.length > 1;
                    const gDef = g.items.reduce((s, { item }) =>
                      s + (item.defects?.length ?? 0), 0);
                    const gErr = g.items.some(({ item }) => item.error);
                    if (!multi) return renderPageItem(g.items[0].item, g.items[0].gi, false);
                    return (
                      <div key={g.setId} className="setgroup">
                        <div className="grouphead">
                          <span className="sethead-main">
                            {renderSetLabel(g.setId, g.name,
                              g.items[0].item.refFile?.name)}
                            {analyzedAt && (
                              <span className="setdate">
                                {fmtDateTime(analyzedAt)} · {g.items.length}장</span>)}
                          </span>
                          {gErr
                            ? <span className="badge err-badge">일부 실패</span>
                            : gDef
                              ? <span className="badge bad-badge">결함 {gDef}</span>
                              : <span className="badge ok-badge">정상</span>}
                        </div>
                        {g.items.map(({ item, gi }) => renderPageItem(item, gi, true))}
                      </div>
                    );
                  })}
                </aside>
                <main className="detail">
                  {(() => {
                    // 다중 페이지 세트면 상세 위에 페이지 탭을 보여 여러 장을 명확히.
                    const g = sel && groups.find((x) => x.setId === sel.setId);
                    if (!g || g.items.length <= 1) return null;
                    return (
                      <div className="pagetabs">
                        {g.items.map(({ item, gi }) => (
                          <button type="button" key={gi}
                                  className={"pagetab" + (gi === selected ? " on" : "")}
                                  onClick={() => setSelected(gi)}>
                            페이지 {item.page}
                            {item.error ? " ⚠"
                              : item.defects?.length ? ` · 결함 ${item.defects.length}`
                                : " · 정상"}
                          </button>
                        ))}
                      </div>
                    );
                  })()}
                  {sel && (
                    <ResultDetail item={sel}
                                  onOpenModal={(m) =>
                                    setModalState({ idx: results.indexOf(sel), m })} />
                  )}
                </main>
              </div>
              {modal && results[modal.idx] && (
                <FeedbackModal modal={modal.m} item={results[modal.idx]}
                               onClose={() => setModalState(null)}
                               onSave={saveModal} onDelete={deleteMissed} />
              )}
            </>
          )}
        </div>
      </>
    );
  }

  // ---------------------------------------------------------------- 검수 페이지
  return (
    <>
      {gnb}
      {adminModal}
      <div className="shell">
        <div className="inspect">
          <aside className="artlib card">
            <div className="artlib-title">
              <span>원본 보관함</span>
              <button type="button" className="sec-add" disabled={running}
                      title={selectedSection
                        ? "선택한 섹션 아래에 하위 섹션을 만듭니다"
                        : "최상위 섹션을 만듭니다"}
                      onClick={() => setAddingSection(true)}>＋ 섹션</button>
            </div>
            <div className="lib-tools">
              <button type="button" disabled={running} onClick={onExportLibrary}
                      {...tip("보관함 전체(원본 + 섹션)를 파일 하나로 내려받아 둡니다. 유실에 대비한 로컬 백업이에요.")}>
                ⬇ 백업</button>
              <button type="button" disabled={running}
                      onClick={() => libImportRef.current?.click()}
                      {...tip("백업 파일을 골라 보관함을 되살립니다. 기존 항목은 지우지 않고 병합돼요.")}>
                ⬆ 복원</button>
              <input ref={libImportRef} type="file" accept=".json,application/json"
                     hidden onChange={(e) => {
                       const f = e.target.files?.[0];
                       if (f) onImportLibrary(f);
                       e.target.value = "";
                     }} />
            </div>
            {hasLibraryServer && (
              <div className="lib-tools">
                <button type="button" disabled={running || serverBusy}
                        onClick={() => { setServerAct("push"); setServerPw(""); }}
                        {...tip("로컬 보관함을 공용 서버에 올려 팀과 공유합니다. 비밀번호가 필요해요.")}>
                  ☁ 서버백업</button>
                <button type="button" disabled={running || serverBusy}
                        onClick={() => { setServerAct("pull"); setServerPw(""); }}
                        {...tip("공용 서버의 최신 백업을 받아 로컬 보관함에 병합합니다. 비밀번호가 필요해요.")}>
                  ☁ 불러오기</button>
              </div>
            )}
            {hoverTip && <p className="lib-tip" role="tooltip">{hoverTip}</p>}
            {serverAct && (
              <div className="sec-edit">
                <input autoFocus type="password" value={serverPw}
                  placeholder={serverAct === "push" ? "백업 비밀번호" : "불러오기 비밀번호"}
                  onChange={(e) => setServerPw(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") runServerSync();
                    if (e.key === "Escape") { setServerAct(null); setServerPw(""); }
                  }} />
                <button type="button" onClick={runServerSync}>확인</button>
              </div>
            )}
            {libStatus && <p className="lib-status">{libStatus}</p>}
            {selectedSection && (
              <div className="sec-selbar">
                <span>선택됨: <b>{sections.find((s) => s.id === selectedSection)?.name}</b>
                  {" "}— ＋섹션은 이 아래에 생깁니다</span>
                <button type="button" onClick={() => setSelectedSection(null)}>해제</button>
              </div>
            )}
            {addingSection && (
              <div className="sec-edit">
                <input autoFocus value={sectionDraft}
                  placeholder={selectedSection ? "하위 섹션 이름" : "섹션 이름"}
                  onChange={(e) => setSectionDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onAddSection();
                    if (e.key === "Escape") { setAddingSection(false); setSectionDraft(""); }
                  }} />
                <button type="button" onClick={onAddSection}>확인</button>
              </div>
            )}
            {recent.length === 0 && sections.length === 0 && (
              <p className="artlib-empty">
                원본을 올리면 여기에 자동 저장됩니다.<br />
                섹션으로 정리할 수 있어요.
              </p>
            )}
            {/* 미분류 — 섹션이 있으면 항상 표시(드롭으로 되돌릴 수 있게) */}
            {(() => {
              const unfiled = recent.filter((a) =>
                !a.section || !sections.some((s) => s.id === a.section));
              if (unfiled.length === 0 && sections.length === 0) return null;
              return (
                <div className={"sec-group" + (dragOverSec === "" ? " dragover" : "")}
                     {...dropProps("")}>
                  {sections.length > 0 && <div className="sec-head plain">미분류</div>}
                  {unfiled.map(renderArtwork)}
                  {unfiled.length === 0 && sections.length > 0 && (
                    <div className="sec-empty">여기로 드래그하면 분류 해제</div>
                  )}
                </div>
              );
            })()}
            {/* 섹션별 — 최상위만 재귀 렌더(하위는 renderSection 안에서) */}
            {sections.filter((s) => !s.parentId ||
              !sections.some((p) => p.id === s.parentId))
              .map((s) => renderSection(s, 0))}
          </aside>
          <div className="inspect-main">
            <div className="sets">
              {pairs.map((p, i) => {
                const rc = pageCount(p.ref), tc = pageCount(p.test);
                const bad = rc > 0 && tc > 0 && rc !== tc;
                const okMatch = rc > 0 && rc === tc;
                return (
                  <div className="pair card" key={p.id}>
                    <div className="pairhead">
                      <b>{p.name || `세트 ${i + 1}`}</b>
                      {pairs.length > 1 && (
                        <button type="button" className="rm" disabled={running}
                                onClick={() => removePair(p.id)}>삭제</button>
                      )}
                    </div>
                    <div className="pairzones">
                      <MultiDropZone label="① 원본" entries={p.ref}
                        busy={!!converting[`${p.id}:ref`]} disabled={running}
                        onAdd={(fs) => addFiles(p.id, "ref", fs)}
                        onRemove={(n) => removeEntry(p.id, "ref", n)}
                        onReorder={(f, t) => reorderEntry(p.id, "ref", f, t)}
                        onAddArtwork={(h) => addArtworkToPair(p.id, "ref", h)} />
                      <MultiDropZone label="② 인쇄물" entries={p.test}
                        busy={!!converting[`${p.id}:test`]} disabled={running}
                        onAdd={(fs) => addFiles(p.id, "test", fs)}
                        onRemove={(n) => removeEntry(p.id, "test", n)}
                        onReorder={(f, t) => reorderEntry(p.id, "test", f, t)}
                        onAddArtwork={(h) => addArtworkToPair(p.id, "test", h)} />
                    </div>
                    {(rc > 0 || tc > 0) && (
                      <div className={"pairmatch" + (bad ? " bad" : okMatch ? " ok" : "")}>
                        원본 {rc}장 · 인쇄물 {tc}장
                        {okMatch && " · 매칭 ✓"}
                        {bad && " · 페이지 수가 다릅니다 ✗"}
                      </div>
                    )}
                  </div>
                );
              })}
              <button type="button" className="add card" disabled={running}
                      onClick={addPair}>
                + 세트 추가
              </button>
            </div>
            <div className="card runbar">
              <label className="opt">
                <input type="checkbox" checked={useOcr}
                       onChange={(e) => setUseOcr(e.target.checked)} />{" "}
                OCR 텍스트 대조 사용
              </label>
              <span className="startwrap" title={
                anyConverting
                  ? "PDF 변환이 끝나면 검수를 시작할 수 있습니다."
                  : mismatch
                    ? "원본과 인쇄물의 페이지 수가 같아야 검수할 수 있습니다."
                    : !allComplete
                      ? "모든 세트에 원본과 인쇄물을 올려야 시작할 수 있습니다."
                      : undefined
              }>
                <button className="go wide"
                        disabled={!allComplete || running || anyConverting}
                        onClick={run}>
                  검수 시작{pairs.length > 1 ? ` (${pairs.length}세트)` : ""}
                </button>
              </span>
              <div id="status">
                {running && (<><span className="spin" />{stageText}… {elapsed}초</>)}
                {error && <span className="err">오류: {error}</span>}
              </div>
              {logs.length > 0 && (
                <details>
                  <summary className="note">자세한 로그</summary>
                  <div className="logbox">{logs.join("\n")}</div>
                </details>
              )}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
