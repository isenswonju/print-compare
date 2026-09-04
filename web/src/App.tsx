// 인쇄 검수 브라우저판 — 분석은 전부 접속자 브라우저 안에서 실행된다.
// 검수(업로드) / 결과 페이지를 상단 GNB로 전환. 결과는 좌측 세트 목록 +
// 우측 상세(마스터-디테일). 다중 세트는 메모리가 허용하면 동시 2세트 병렬.
import React, { useEffect, useRef, useState } from "react";
import { clearSession, createSection, deleteArtwork, deleteSection,
         getArtworkFile, hashFile, listArtworks, listSections, loadSession,
         moveSection, renameSection, requestPersistentStorage, saveArtwork,
         saveSession, setArtworkSection, storageEstimate, type ArtworkEntry,
         type Section, type StoredSet } from "./cache.ts";
import { MultiDropZone, FeedbackModal, ResultDetail,
         type ModalState } from "./components.tsx";
import { applySetName, buildErrorReport, buildFeedbackPayload, copyToClipboard,
         download, entryDay, feedbackCsv, flushFbQueue, fmtDateTime, fmtMB,
         hasFeedbackEndpoint, loadFbQueue, restoreResults, saveFbQueue,
         serializeResults, slimPayload, summarizeFeedbackForChat,
         trySendFeedback, type AdminEntry } from "./lib.ts";
import { hasLibraryServer, syncLibraryWithServer,
         type SyncProgress } from "./server-library.ts";
import { runAll, type RunSet } from "./runner.ts";
import { proposePrep, rasterWithPrep, savedPrep, saveSetting, toSetting,
         type PrepProposal } from "./artwork-flow.ts";
import { ensureRasterPages } from "./pipeline/pdf.ts";
import { branding } from "./branding.ts";
import type { FileEntry, ResultItem, SetFb } from "./types.ts";

// 세트 = 한 품목. 원본/인쇄물 각각 여러 파일(각 파일은 PDF면 여러 페이지)을
// 받아 페이지 목록으로 펼친다. 양쪽 총 페이지 수가 같아야 검수를 시작할 수 있다.
// multi(다중 샘플): 인쇄물 스캔 한 장에 같은 샘플이 여러 개 — 원본 1장·인쇄물
// 1장만 받고, 샘플 위치를 자동 검출해 샘플별로 나눠 검수한다.
interface Pair {
  id: number; ref: FileEntry[]; test: FileEntry[]; name?: string;
  multi?: boolean;
}

const pageCount = (side: FileEntry[]) =>
  side.reduce((s, e) => s + e.pages.length, 0);
const flatPages = (side: FileEntry[]) => side.flatMap((e) => e.pages);

let pairSeq = 0;

export default function App() {
  const [view, setView] = useState<"upload" | "results" | "admin">("upload");
  // 관리자(피드백 조회) — 비번은 앱에 저장하지 않고 수집기 서버가 대조.
  const [adminBusy, setAdminBusy] = useState(false);
  const [adminData, setAdminData] =
    useState<{ count: number; items: AdminEntry[] } | null>(null);
  // 피드백 페이지 — 확인 처리된 id, 날짜 그룹 접힘, 필터, 상태 메시지
  const [adminRead, setAdminRead] = useState<string[]>([]);
  const [adminClosed, setAdminClosed] = useState<Record<string, boolean>>({});
  const [adminOnlyNew, setAdminOnlyNew] = useState(false);
  const [adminMsg, setAdminMsg] = useState("");
  // 삭제 확인 대기 — 브라우저 confirm 대신 버튼을 두 번 눌러 확정한다.
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
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
  // 분석 실패 페이지의 오류 보고 — 열려 있는 결과 인덱스와 사용자가 적은 메모
  const [errOpen, setErrOpen] = useState<number | null>(null);
  const [errNote, setErrNote] = useState<Record<number, string>>({});
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
  const [libStatus, setLibStatus] = useState(""); // 서버 동기화 안내
  const [hoverTip, setHoverTip] = useState(""); // 버튼 호버 설명
  // 공용 보관함 — 연결 절차·비밀번호 없음. 앱을 열면 곧바로 서버와 맞춘다.
  const [serverBusy, setServerBusy] = useState(false);
  const [lastSync, setLastSync] = useState<number | null>(null);
  const syncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncAgainRef = useRef(false); // 동기화 중 변경이 또 생기면 한 번 더
  const [dragOverSec, setDragOverSec] = useState<string | null>(null);
  // 폴더를 드래그 중일 때 그 폴더 id — 자기 자신 위로는 드롭 표시를 하지 않는다.
  const [dragSec, setDragSec] = useState<string | null>(null);
  // 보관함으로 직접 떨어뜨린 파일을 저장하는 중인 폴더 id(""=미분류)
  const [libDropBusy, setLibDropBusy] = useState(false);
  // 저장소 사용량 — 보관함이 커질 때 한계를 미리 알리기 위한 표시
  const [storage, setStorage] =
    useState<{ usage: number; quota: number; persisted: boolean } | null>(null);
  const [editingSet, setEditingSet] = useState<number | null>(null); // 이름 편집 중인 setId
  const [restored, setRestored] = useState(false);
  // 분석 수행 시각 — 결과가 7일 보존되므로 언제 분석한 것인지 표시한다
  const [analyzedAt, setAnalyzedAt] = useState<number | null>(null);
  // PDF 변환 중인 드롭존 키(`id:ref`/`id:test`) — 변환 끝날 때까지 검수 시작 차단
  const [converting, setConverting] = useState<Record<string, boolean>>({});
  // 아트웍 정리 확인 — 원판에서 설명 요소를 걷어낼지 사용자가 한 번 정한다.
  // 확정값은 아트웍 해시에 붙어 공용 보관함으로 팀에 퍼진다(원판당 1회).
  const [prepAsk, setPrepAsk] =
    useState<{ pairId: number; proposal: PrepProposal } | null>(null);
  const [prepLayers, setPrepLayers] = useState<string[]>([]);
  const [prepCand, setPrepCand] = useState(-1);
  const [prepBusy, setPrepBusy] = useState(false);
  const [prepPending, setPrepPending] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // 저장된 세션 스냅샷 — 피드백만 바뀔 때 이미지 재직렬화를 피하려고 들고 있는다
  const storedRef = useRef<StoredSet[] | null>(null);
  const analyzedAtRef = useRef<number | null>(null); // 재저장 시 분석 시각 유지

  const pushLog = (m: string) => setLogs((l) => [...l, m]);

  // 보관함(원본 + 폴더) 새로고침. 저장소 사용량도 같이 갱신한다.
  const refreshLibrary = () =>
    Promise.all([listArtworks(), listSections(), storageEstimate()])
      .then(([a, s, st]) => { setRecent(a); setSections(s); setStorage(st); });

  // 보관함에 파일을 직접 넣는다(사이드바로 끌어놓기). 원본 파일 그대로 저장하고
  // 떨어뜨린 폴더에 배정한다. 이미지가 아닌 파일은 조용히 무시한다.
  const addFilesToLibrary = async (files: File[], section: string) => {
    const accepted = files.filter((f) =>
      /\.(png|jpe?g|pdf)$/i.test(f.name) ||
      /^(image\/(png|jpeg)|application\/pdf)$/.test(f.type));
    if (accepted.length === 0) {
      setLibStatus("PNG · JPG · PDF 파일만 보관함에 넣을 수 있습니다.");
      return;
    }
    setLibDropBusy(true);
    try {
      for (const f of accepted)
        await saveArtwork(await hashFile(f), f, section || undefined);
      await refreshLibrary();
      scheduleSync();
      setLibStatus(`보관함에 ${accepted.length}개 저장됨` +
        (accepted.length < files.length
          ? ` (${files.length - accepted.length}개는 형식이 맞지 않아 제외)` : ""));
    } catch (e) {
      setLibStatus("보관함 저장 실패: " + String((e as Error).message || e));
    } finally {
      setLibDropBusy(false);
    }
  };

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
        // 원본 면은 이미 확정된 전처리가 있으면 그대로 적용해 넣는다.
        // 확정된 게 없으면 평소대로 넣고, 아래에서 정리 제안을 띄운다.
        const prep = which === "ref"
          ? await hashFile(file).then(savedPrep).catch(() => undefined)
          : undefined;
        const pages = prep
          ? await rasterWithPrep(file, prep, undefined, pushLog)
          : await ensureRasterPages(file, undefined, pushLog);
        if (prep) pushLog(`[정리] ${file.name} — 저장된 아트웍 정리 설정 적용`);
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
      // 저장이 끝난 뒤에 새로고침해야 방금 넣은 파일이 바로 보인다 — 예전에는
      // 저장을 기다리지 않고 목록을 읽어 새로고침해야 나타났다.
      if (which === "ref") {
        await Promise.all(newEntries.map((e) =>
          hashFile(e.file).then((h) => saveArtwork(h, e.file)).catch(() => {})));
        await refreshLibrary();
        scheduleSync();
        // 아직 정리 설정이 없는 원판이면 제안을 띄운다(파일 1개일 때만 —
        // 여러 장을 한꺼번에 물어보면 흐름이 끊긴다).
        if (newEntries.length === 1) await askPrep(id, newEntries[0].file);
      }
    } catch (err) {
      setError(`파일 처리 실패: ` + String((err as Error).message || err));
    } finally {
      setConverting((c) => { const n = { ...c }; delete n[key]; return n; });
    }
  };
  // 원판 정리 제안 — 이미 확정된 게 있으면 묻지 않는다(팀에서 한 번만 정한다).
  const askPrep = async (pairId: number, file: File) => {
    setPrepPending(true);
    try {
      const hash = await hashFile(file).catch(() => "");
      if (hash && (await savedPrep(hash))) return;
      const proposal = await proposePrep(file, pushLog);
      // 걷어낼 것도, 고를 후보도 없으면 물어볼 이유가 없다.
      const hasLayer = proposal.layers.some((l) => l.annotationLike);
      if (!hasLayer && proposal.suggested < 0 && proposal.candidates.length < 2)
        return;
      setPrepLayers(proposal.layers.filter((l) => l.annotationLike)
                                   .map((l) => l.id));
      setPrepCand(proposal.suggested);
      setPrepAsk({ pairId, proposal });
    } catch (e) {
      pushLog("[정리] 아트웍 분석 실패(원본 그대로 진행): " +
        String((e as Error).message || e));
    } finally {
      setPrepPending(false);
    }
  };

  // 확정 — 설정을 보관함에 저장(동기화로 팀 전체에 전파)하고 세트에 다시 넣는다.
  const applyPrep = async (useIt: boolean) => {
    if (!prepAsk) return;
    const { pairId, proposal } = prepAsk;
    setPrepBusy(true);
    try {
      const setting = useIt
        ? toSetting(proposal, prepLayers, prepCand)
        : { at: Date.now() }; // "원본 그대로" 도 확정이다 — 다시 묻지 않는다
      await saveSetting(proposal.hash, setting);
      await refreshLibrary();
      scheduleSync();
      if (useIt) {
        const pages = await rasterWithPrep(
          proposal.file, setting, undefined, pushLog);
        setPairs((ps) => ps.map((p) => p.id === pairId
          ? { ...p, ref: p.ref.map((e) => e.file === proposal.file
              ? { ...e, pages } : e) } : p));
        pushLog(`[정리] ${proposal.file.name} — 라벨만 남겨 적용했습니다.`);
      }
      setPrepAsk(null);
    } catch (e) {
      setError("아트웍 정리 실패: " + String((e as Error).message || e));
    } finally {
      setPrepBusy(false);
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
    // 로컬에 본체가 없으면 서버에서 내려받는다 — 그동안 안내를 띄운다.
    const cached = recent.find((a) => a.hash === hash);
    if (cached && !cached.blob)
      setLibStatus(`"${cached.name}" 서버에서 내려받는 중…`);
    const f = await getArtworkFile(hash);
    if (cached && !cached.blob) {
      setLibStatus(f ? "" : `"${cached.name}"을(를) 내려받지 못했습니다 — ` +
        "네트워크를 확인하고 다시 시도해주세요.");
      if (f) refreshLibrary(); // ☁ 표시 해제(이제 로컬에 있음)
    }
    if (!f) return;
    const art = recent.find((a) => a.hash === hash);
    const sec = art?.section && sections.find((s) => s.id === art.section);
    // 원본에 투입 시: 섹션명으로 세트명 지정, 미분류면 ""(→ 기본 "세트 N")로 리셋.
    const setName = which === "ref" ? (sec ? sec.name : "") : undefined;
    await addFiles(id, which, [f], setName);
  };
  const anyConverting = Object.values(converting).some(Boolean);
  const editingLocked = running || anyConverting || prepPending || prepBusy || !!prepAsk;
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
    // 공용 보관함 — 앱을 열면 곧바로 서버와 목록을 맞춘다(연결 절차 없음).
    doSync(true);
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

  // 보관함 폴더 관리 — 선택된 상위 폴더가 있으면 그 아래에 만든다.
  // (내부 자료형 이름은 Section 그대로 두고 화면 용어만 '폴더'로 통일했다.)
  const onAddSection = async () => {
    const name = sectionDraft.trim();
    const parent = selectedSection ?? undefined;
    setAddingSection(false); setSectionDraft("");
    if (name) {
      await createSection(name, parent);
      if (parent) setExpanded((x) => ({ ...x, [parent]: true })); // 부모 펼쳐 보이기
      refreshLibrary();
      scheduleSync();
    }
  };
  const onRenameSection = async (id: string, name: string) => {
    setEditingSection(null);
    if (name.trim()) {
      await renameSection(id, name.trim()); refreshLibrary(); scheduleSync();
    }
  };
  const onDeleteSection = async (id: string) => {
    await deleteSection(id);
    setSelectedSection((cur) => (cur === id ? null : cur));
    refreshLibrary();
    scheduleSync();
  };
  const onDeleteArtwork = async (hash: string) => {
    await deleteArtwork(hash); refreshLibrary(); scheduleSync();
  };
  const onSetSection = async (hash: string, section: string) => {
    await setArtworkSection(hash, section || undefined);
    refreshLibrary();
    scheduleSync();
  };
  // 폴더를 다른 폴더 안으로 이동. 자기 자신·자기 하위로는 못 옮긴다(cache에서 차단).
  const onMoveSection = async (id: string, parent: string) => {
    const ok = await moveSection(id, parent || undefined);
    if (!ok && parent) {
      setLibStatus("자기 자신이나 하위 폴더로는 옮길 수 없습니다.");
      return;
    }
    if (parent) setExpanded((x) => ({ ...x, [parent]: true }));
    refreshLibrary();
    scheduleSync();
  };

  // 공용 보관함 동기화 — 서버가 원본이고 모두가 같은 보관함 하나를 본다.
  // 앱을 열 때 + 보관함이 바뀔 때마다 자동으로 맞춘다(수동 버튼도 남겨둠).
  // 파일 본체는 내려받지 않고 목록만 맞추므로 보관함이 커도 몇 초면 끝난다.
  const onSyncProgress = (p: SyncProgress) =>
    setLibStatus(p.total > 1
      ? `${p.phase} ${p.done}/${p.total}…`
      : `${p.phase}…`);

  const syncBusyRef = useRef(false);
  const doSync = async (quiet = false) => {
    if (!hasLibraryServer) return;
    if (syncBusyRef.current) { syncAgainRef.current = true; return; }
    syncBusyRef.current = true;
    setServerBusy(true);
    if (!quiet) setLibStatus("공용 보관함 동기화 중…");
    try {
      const r = await syncLibraryWithServer(quiet ? undefined : onSyncProgress);
      await refreshLibrary();
      setLastSync(Date.now());
      setLibStatus(quiet ? "" :
        `동기화 완료 — 원본 ${r.artworks}개 · 폴더 ${r.sections}개` +
        (r.uploaded ? ` · 새로 올림 ${r.uploaded}개` : "") +
        (r.freed ? ` · 로컬 공간 확보 ${r.freed}개` : ""));
    } catch (e) {
      // 서버가 잠깐 안 되면 로컬 보관함으로 계속 쓰고, 다음 변경 때 다시 맞춘다.
      setLibStatus("동기화 실패(로컬 보관함은 그대로): " +
        String((e as Error).message || e));
    } finally {
      syncBusyRef.current = false;
      setServerBusy(false);
      if (syncAgainRef.current) {
        syncAgainRef.current = false;
        scheduleSync();
      }
    }
  };

  // 보관함이 바뀐 뒤 잠깐 뜸을 들였다가 동기화한다(연속 조작을 한 번에).
  const scheduleSync = () => {
    if (!hasLibraryServer) return;
    if (syncTimerRef.current) clearTimeout(syncTimerRef.current);
    syncTimerRef.current = setTimeout(() => {
      syncTimerRef.current = null;
      doSync(true);
    }, 2500);
  };

  // 백업/복원 버튼 호버·포커스 시 간단한 설명을 아래 안내 박스로 보여준다
  // (좁은 사이드바 + overflow 클리핑 때문에 떠 있는 툴팁 대신 인라인 박스).
  const tip = (t: string) => ({
    onMouseEnter: () => setHoverTip(t),
    onMouseLeave: () => setHoverTip((c) => (c === t ? "" : c)),
    onFocus: () => setHoverTip(t),
    onBlur: () => setHoverTip((c) => (c === t ? "" : c)),
  });

  // 저장소 사용량 안내 — 보관함이 커지면 브라우저 할당량이 한계가 되므로
  // 미리 보여준다. persisted가 아니면 저장공간 압박 시 통째로 지워질 수 있다.
  const storageNote = (() => {
    if (!storage?.quota) return null;
    const pct = storage.usage / storage.quota;
    const cachedN = recent.filter((a) => a.blob).length;
    const text = `원본 ${recent.length}개` +
      (cachedN < recent.length ? ` (이 기기에 ${cachedN}개)` : "") +
      ` · ${fmtMB(storage.usage)} 사용` +
      ` / 한도 ${fmtMB(storage.quota)} (${Math.round(pct * 100)}%)` +
      (storage.persisted ? "" : " · 자동삭제 방지 미적용");
    // 서버가 정본이라 로컬이 차도 자동으로 비워진다 — 용량은 경고하지 않는다.
    return { text, warn: !storage.persisted };
  })();

  // 보관함 원본 한 행: 클릭해 투입 + 드래그해서 폴더 이동 + 삭제.
  const renderArtwork = (a: ArtworkEntry) => (
    <div className="artitem-row" key={a.hash} draggable={!running}
         onDragStart={(e) => {
           e.dataTransfer.setData("text/hash", a.hash);
           e.dataTransfer.effectAllowed = "move";
         }}>
      <span className="art-grip" title="드래그해서 폴더로 이동">⠿</span>
      <button type="button" className="artitem" disabled={running}
              title={`${a.name} (${fmtMB(a.size)}) — 클릭해서 원본에 투입` +
                     (a.blob ? "" : " (서버에서 내려받음)")}
              onClick={() => applyArtwork(a.hash)}>
        <span className="artname">{a.name}</span>
        {/* blob이 로컬에 없는 항목 — 서버에만 있고 쓸 때 내려받는다 */}
        {!a.blob && <span className="art-cloud" title="서버에 보관 중 — 사용 시 내려받음">☁</span>}
        <span className="artsize">{fmtMB(a.size)}</span>
      </button>
      <button type="button" className="art-del" disabled={running}
              title="보관함에서 삭제" onClick={() => onDeleteArtwork(a.hash)}>✕</button>
    </div>
  );

  // 드롭 대상(폴더/미분류) 공통 핸들러. 받는 것은 세 가지다.
  //  1) 보관함 원본(text/hash)     — 그 폴더로 분류 이동
  //  2) 폴더(text/section)         — 그 폴더의 하위로 이동
  //  3) 바깥에서 끌어온 파일        — 보관함에 저장하며 그 폴더에 배정
  // 중첩 폴더에서 부모로 버블링되지 않게 stopPropagation — 가장 안쪽에만 적용.
  const dropProps = (sectionId: string) => ({
    onDragOver: (e: React.DragEvent) => {
      if (running) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      // 자기 자신 위로 끌고 있을 때는 드롭 강조를 하지 않는다.
      setDragOverSec(dragSec && dragSec === sectionId ? null : sectionId);
    },
    onDragLeave: () => setDragOverSec((s) => (s === sectionId ? null : s)),
    onDrop: (e: React.DragEvent) => {
      if (running) return;
      e.preventDefault(); e.stopPropagation();
      setDragOverSec(null);
      const hash = e.dataTransfer.getData("text/hash");
      const sec = e.dataTransfer.getData("text/section");
      const files = [...(e.dataTransfer.files ?? [])];
      if (hash) onSetSection(hash, sectionId);
      else if (sec) { setDragSec(null); onMoveSection(sec, sectionId); }
      else if (files.length) addFilesToLibrary(files, sectionId);
    },
  });

  // 폴더 재귀 렌더 — 기본 닫힘, 선택된 상위 폴더는 강조. depth로 들여쓰기.
  // 자식 폴더는 부모가 펼쳐졌을 때만 보인다. 폴더 자체도 드래그해 옮길 수 있다.
  const renderSection = (s: Section, depth: number): React.ReactNode => {
    const arts = recent.filter((a) => a.section === s.id);
    const children = sections.filter((c) => c.parentId === s.id);
    const isOpen = !!expanded[s.id];
    const isSel = selectedSection === s.id;
    return (
      <div className={"sec-group" +
             (dragOverSec === s.id ? " dragover" : "") +
             (dragSec === s.id ? " dragging" : "")}
           key={s.id} {...dropProps(s.id)}>
        <div className={"sec-head" + (isSel ? " selected" : "")}
             style={{ paddingLeft: depth * 12 }}
             draggable={!running && editingSection !== s.id}
             onDragStart={(e) => {
               e.stopPropagation();
               e.dataTransfer.setData("text/section", s.id);
               e.dataTransfer.effectAllowed = "move";
               setDragSec(s.id);
             }}
             onDragEnd={() => { setDragSec(null); setDragOverSec(null); }}>
          <button type="button" className="sec-toggle" disabled={running}
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
                  title={"클릭: 선택(＋폴더가 여기 아래에 생깁니다) · " +
                         "더블클릭: 이름 변경 · 드래그: 다른 폴더로 이동"}
                  onClick={() => !running &&
                    setSelectedSection((cur) => (cur === s.id ? null : s.id))}
                  onDoubleClick={() => !running && setEditingSection(s.id)}>
              📁 {s.name} <span className="sec-count">{arts.length}</span>
              {children.length > 0 &&
                <span className="sec-count">· {children.length}폴더</span>}
            </span>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="sec-btn" title="이름 변경"
                  disabled={running}
                  onClick={() => setEditingSection(s.id)}>✎</button>
          <button type="button" className="sec-btn" title="폴더 삭제(원본은 미분류로)"
                  disabled={running}
                  onClick={() => onDeleteSection(s.id)}>🗑</button>
        </div>
        {isOpen && (
          <>
            {children.map((c) => renderSection(c, depth + 1))}
            {arts.map(renderArtwork)}
            {arts.length === 0 && children.length === 0 && (
              <div className="sec-empty">여기로 파일이나 폴더를 끌어놓으세요</div>
            )}
          </>
        )}
      </div>
    );
  };

  // 세트가 완성되려면 원본·인쇄물 모두 1장 이상이고 총 페이지 수가 같아야 한다.
  // 다중 샘플 세트는 원본 1장 + 인쇄물 스캔 1장이어야 한다(샘플 수는 자동 검출).
  const pairComplete = (p: Pair) => p.multi
    ? pageCount(p.ref) === 1 && pageCount(p.test) === 1
    : pageCount(p.ref) > 0 && pageCount(p.ref) === pageCount(p.test);
  const completePairs = pairs.filter(pairComplete);
  // 모든 세트가 완성돼야 검수 시작 가능. 페이지 수 불일치 세트가 있으면 안내.
  const allComplete = pairs.length > 0 && completePairs.length === pairs.length;
  const mismatch = pairs.some((p) => !p.multi &&
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
        multiSample: p.multi,
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

  // 분석이 실패한 페이지의 오류 보고 — 결함 크롭이 없어 일반 피드백을 만들 수
  // 없으므로, 오류 문구·입력 파일 정보·실행 로그만 모아 바로 보낼 수 있게 한다.
  async function sendErrorReport(idx: number) {
    const item = results[idx];
    if (!item?.error) return;
    setSendingIdx(idx);
    const setStatus = (msg: string) =>
      setResults((rs) => rs.map((it, i) =>
        i === idx ? { ...it, fbStatus: msg } : it));
    try {
      const payload = buildErrorReport([item], logs, errNote[idx]);
      if (!hasFeedbackEndpoint) {
        download(`error_${Date.now()}.json`, new Blob(
          [JSON.stringify(payload)], { type: "application/json" }));
        setStatus("파일로 저장됨 — 품질 담당자에게 전달해주세요.");
        return;
      }
      if (await trySendFeedback(payload)) {
        setStatus("오류 보고 전송 완료 ✓");
        setErrOpen(null);
        return;
      }
      // 연결 불가 — 일반 피드백과 같은 보류 큐에 넣어 다음 방문에 재전송.
      const q = loadFbQueue();
      q.push(payload);
      if (saveFbQueue(q))
        setStatus("서버 연결 불가 — 보관됨, 다음 방문 시 자동 전송");
      else
        setStatus("전송·보관 모두 실패했습니다. 로그를 복사해 전달해주세요.");
    } finally {
      setSendingIdx(null);
    }
  }

  // 피드백 조회 — 인증 없이 목록을 받아온다.
  async function submitAdmin(e?: React.FormEvent) {
    e?.preventDefault();
    const adminUrl = branding.feedback?.adminUrl;
    if (!adminUrl) return;
    setAdminBusy(true);
    setAdminMsg("");
    try {
      const r = await fetch(adminUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!r.ok) { setFbStatus(`피드백을 불러오지 못했습니다 (오류 ${r.status})`); return; }
      const data = await r.json();
      setAdminData(data);
      setAdminRead(Array.isArray(data.read) ? data.read : []);
      setView("admin");
    } catch {
      setFbStatus("수집기에 연결할 수 없습니다.");
    } finally {
      setAdminBusy(false);
    }
  }

  // 피드백 관리 액션(확인 토글·삭제). 인증 없이 동작한다 — 삭제는 화면에서
  // 두 번 눌러 확정하는 단계가 실수를 막는다.
  async function adminPost(body: Record<string, unknown>) {
    const url = branding.feedback?.adminUrl;
    if (!url) throw new Error("수집기 주소가 설정되지 않았습니다.");
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`서버 오류: ${r.status}`);
    return r.json();
  }

  // 확인/미확인 토글. 먼저 화면을 바꾸고(즉각 반응) 실패하면 되돌린다.
  const setEntriesRead = async (ids: string[], read: boolean) => {
    if (!ids.length) return;
    const before = adminRead;
    setAdminRead(read
      ? [...new Set([...before, ...ids])]
      : before.filter((x) => !ids.includes(x)));
    setAdminMsg("");
    try {
      const r = await adminPost({ action: "read", ids, read });
      if (Array.isArray(r.read)) setAdminRead(r.read);
    } catch (e) {
      setAdminRead(before);
      setAdminMsg("상태 저장 실패: " + String((e as Error).message || e));
    }
  };

  const deleteEntries = async (ids: string[]) => {
    if (!ids.length) return;
    setAdminBusy(true);
    setAdminMsg("");
    try {
      await adminPost({ action: "delete", ids });
      setAdminData((d) => d && {
        ...d, count: Math.max(0, d.count - ids.length),
        items: d.items.filter((it: AdminEntry) => !ids.includes(it.id)) });
      setAdminRead((r) => r.filter((x) => !ids.includes(x)));
      setAdminMsg(`${ids.length}건 삭제됨`);
    } catch (e) {
      setAdminMsg("삭제 실패: " + String((e as Error).message || e));
    } finally {
      setAdminBusy(false);
      setPendingDelete(null);
    }
  };

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

  // 세트 내 한 결과의 라벨 — 다중 샘플이면 "샘플 N", 다중 페이지면 "페이지 N".
  const pageLabel = (item: ResultItem) =>
    item.instance != null ? `샘플 ${item.instance}` : `페이지 ${item.page}`;

  // 한 페이지 결과 항목(헤드 + 피드백 상세 + 전송). multi면 "페이지/샘플 N" 표기.
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
      <div key={item.setId + "-" + item.page + "-" + (item.instance ?? 0)}
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
              ? <span className="setname">{pageLabel(item)}</span>
              : renderSetLabel(item.setId, item.name, item.refFile?.name)}
            {!multi && analyzedAt && (
              <span className="setdate">{fmtDateTime(analyzedAt)}</span>)}
          </span>
          {badge}
        </div>
        {/* 실패한 페이지 — 오류 문구를 보여주고 그 자리에서 보고할 수 있게 한다 */}
        {item.error && (
          <div className="errbox">
            <p className="errmsg" title={item.error}>{item.error}</p>
            {errOpen === rIdx ? (
              <>
                <textarea className="errnote" autoFocus
                  placeholder="무엇을 하다가 실패했는지 적어주세요(선택)"
                  value={errNote[rIdx] ?? ""}
                  onChange={(e) =>
                    setErrNote((n) => ({ ...n, [rIdx]: e.target.value }))} />
                <div className="fbsend">
                  <button type="button" className="go save"
                          disabled={sendingIdx === rIdx}
                          onClick={() => sendErrorReport(rIdx)}>
                    {sendingIdx === rIdx ? "전송 중…" : "오류 보고 보내기"}
                  </button>
                  <button type="button" className="rm"
                          onClick={() => setErrOpen(null)}>취소</button>
                </div>
                <p className="note errhint">
                  오류 문구 · 파일 이름/크기 · 실행 로그만 보냅니다(이미지 제외).
                </p>
              </>
            ) : (
              <button type="button" className="rm errsend"
                      onClick={() => setErrOpen(rIdx)}>⚠ 오류 보고</button>
            )}
            {item.fbStatus && <span className="note">{item.fbStatus}</span>}
          </div>
        )}
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

  // 아트웍 정리 확인 모달 — 무엇을 걷어낼지 눈으로 보고 확정한다.
  // 미리보기는 페이지 위에 "고른 라벨 = 실선, 지울 영역 = 빗금"으로 겹쳐 그린다.
  const prepModal = prepAsk && (() => {
    const p = prepAsk.proposal;
    const cand = prepCand >= 0 ? p.candidates[prepCand] : null;
    const mmw = (px: number) => (px / 150 * 25.4).toFixed(0); // PREVIEW_DPI=150
    return (
      <div className="modal-back" onClick={() => !prepBusy && setPrepAsk(null)}>
        <div className="modal prep-modal" onClick={(e) => e.stopPropagation()}>
          <h3>아트웍 정리 — {p.file.name}</h3>
          <p className="admin-hint">
            원판에는 실물 인쇄에 없는 설명 요소(색상 견본·재단선·치수·가변
            데이터 자리)가 들어 있습니다. 걷어낼 것을 확인해주세요.{" "}
            <b>한 번만 정하면 이 원판에 대해 팀 전체가 같은 설정을 씁니다.</b>
          </p>
          <div className="prep-body">
            <div className="prep-preview">
              <img src={URL.createObjectURL(p.page)} alt="원판 미리보기" />
              <svg viewBox={`0 0 ${p.pageW} ${p.pageH}`} preserveAspectRatio="none">
                <defs>
                  <pattern id="hatch" width="8" height="8"
                           patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                    <line x1="0" y1="0" x2="0" y2="8" stroke="#c0392b" strokeWidth="4" />
                  </pattern>
                </defs>
                {p.candidates.map((c, i) => (
                  <rect key={i} x={c.x} y={c.y} width={c.w} height={c.h}
                        className={"prep-cand" + (i === prepCand ? " on" : "")}
                        onClick={() => setPrepCand(i === prepCand ? -1 : i)} />
                ))}
                {cand && p.excluded.map((e, i) => (
                  <rect key={"e" + i} x={cand.x + e.x} y={cand.y + e.y}
                        width={e.w} height={e.h} fill="url(#hatch)"
                        opacity="0.5" pointerEvents="none" />
                ))}
              </svg>
            </div>
            <div className="prep-side">
              {p.layers.length > 0 && (
                <>
                  <b>PDF 레이어</b>
                  <p className="note">끌 레이어를 고르세요. 설명 요소로 읽히는
                    이름은 미리 체크해 뒀습니다.</p>
                  {p.layers.map((l) => (
                    <label key={l.id} className="prep-layer">
                      <input type="checkbox"
                        checked={prepLayers.includes(l.id)}
                        onChange={(e) => setPrepLayers((cur) => e.target.checked
                          ? [...cur, l.id] : cur.filter((x) => x !== l.id))} />
                      {" "}{l.name}
                      {l.annotationLike && <span className="note"> · 설명 요소</span>}
                    </label>
                  ))}
                </>
              )}
              <b>라벨 영역</b>
              {p.candidates.length === 0 ? (
                <p className="note">자를 후보를 찾지 못했습니다 — 페이지 전체를 씁니다.</p>
              ) : (
                <>
                  <p className="note">미리보기에서 상자를 눌러 바꿀 수 있습니다.</p>
                  {p.candidates.map((c, i) => (
                    <label key={i} className="prep-layer">
                      <input type="radio" name="cand" checked={i === prepCand}
                             onChange={() => setPrepCand(i)} />
                      {" "}후보 {i + 1} — {mmw(c.w)}×{mmw(c.h)}mm
                      {i === p.suggested && <span className="note"> · 추천</span>}
                    </label>
                  ))}
                  <label className="prep-layer">
                    <input type="radio" name="cand" checked={prepCand === -1}
                           onChange={() => setPrepCand(-1)} />
                    {" "}자르지 않음(페이지 전체)
                  </label>
                </>
              )}
              {prepCand >= 0 && prepCand === p.suggested && p.excluded.length > 0 && (
                <p className="note">라벨 안의 설명 요소 {p.excluded.length}곳을
                  지웁니다(빗금). 가변 데이터 칸이라 실물에서도 비어 있습니다.</p>
              )}
            </div>
          </div>
          <div className="modal-btns">
            <span style={{ flex: 1 }} />
            <button type="button" className="rm" disabled={prepBusy}
                    onClick={() => applyPrep(false)}>원본 그대로 쓰기</button>
            <button type="button" className="go save" disabled={prepBusy}
                    onClick={() => applyPrep(true)}>
              {prepBusy ? "적용 중…" : "이대로 정리해서 쓰기"}</button>
          </div>
        </div>
      </div>
    );
  })();

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
        <a href="/handover.html" target="_blank" rel="noreferrer"
           title="설치·사용·유지보수 설명서를 새 창에서 엽니다">사용설명서</a>
        {running && (
          <span className="gnb-status">
            <span className="spin" />{stageText || "분석 중"} · {elapsed}초
          </span>
        )}
        {branding.feedback?.adminUrl && (
          <button className="gnb-admin" title="피드백 조회"
                  onClick={() => { setAdminMsg(""); submitAdmin(); }}
                  disabled={adminBusy}>💬</button>
        )}
      </div>
    </nav>
  );

  const adminModal = null;   // 인증 없음 — 로그인 모달을 두지 않는다

  // 수집된 피드백 1건(제출 단위) 렌더 — 세트별 결함/누락과 크롭 이미지.
  // 머리글에 확인/미확인 스위치와 삭제(두 번 눌러 확정)를 둔다.
  const renderAdminEntry = (entry: AdminEntry) => {
    const data = entry.data ?? {};
    const when = entry.received || entry.uploadedAt;
    const sets = Array.isArray(data.items) ? data.items : [];
    const isRead = adminRead.includes(entry.id);
    const confirming = pendingDelete === entry.id;
    const isErrorReport = data.kind === "error";
    return (
      <div className={"admin-entry" + (isRead ? " read" : "")} key={entry.id}>
        <div className="admin-entry-head">
          <button type="button"
                  className={"admin-switch" + (isRead ? " on" : "")}
                  title={isRead ? "확인함 — 눌러서 미확인으로" : "미확인 — 눌러서 확인 처리"}
                  onClick={() => setEntriesRead([entry.id], !isRead)}>
            <span className="admin-switch-knob" />
            <span className="admin-switch-label">{isRead ? "확인" : "미확인"}</span>
          </button>
          <b>{when ? new Date(when).toLocaleString("ko-KR") : "시간 미상"}</b>
          <span className="admin-origin">{entry.origin || ""}</span>
          <code className="admin-id" title="이 피드백의 id (복사 내용과 대조용)">
            {entry.id}</code>
          <span className="admin-ver">v{data.version || "?"}</span>
          {confirming ? (
            <span className="admin-confirm">
              <button type="button" className="rm danger" disabled={adminBusy}
                      onClick={() => deleteEntries([entry.id])}>정말 삭제</button>
              <button type="button" className="rm"
                      onClick={() => setPendingDelete(null)}>취소</button>
            </span>
          ) : (
            <button type="button" className="admin-del" title="이 피드백 삭제"
                    onClick={() => setPendingDelete(entry.id)}>🗑</button>
          )}
        </div>
        {entry.error && <div className="admin-empty-set">본문을 읽지 못했습니다: {entry.error}</div>}
        {isErrorReport && (
          <div className="admin-errreport">
            <span className="admin-tag err">분석 실패 보고</span>
            {sets.map((s, si) => (
              <div className="admin-set" key={si}>
                <div className="admin-set-name">
                  {s.set || `세트 ${si + 1}`}
                  {s.page ? ` · 페이지 ${s.page}` : ""}</div>
                <div className="admin-errmsg">{s.error || "오류 문구 없음"}</div>
                {s.note && <div className="admin-comment">“{s.note}”</div>}
                <div className="admin-files">
                  {s.refFile && <span>원본: {s.refFile.name} ({fmtMB(s.refFile.size)})</span>}
                  {s.testFile && <span>인쇄물: {s.testFile.name} ({fmtMB(s.testFile.size)})</span>}
                </div>
                {s.ua && <div className="admin-ua">{s.ua}</div>}
                {!!s.logs?.length && (
                  <details>
                    <summary className="note">실행 로그 {s.logs.length}줄</summary>
                    <div className="logbox">{s.logs.join("\n")}</div>
                  </details>
                )}
              </div>
            ))}
          </div>
        )}
        {!isErrorReport && sets.map((s, si) => {
          const fb = s?.feedback ?? {};
          const defects = Array.isArray(fb.defects) ? fb.defects : [];
          const missed = Array.isArray(fb.missed) ? fb.missed : [];
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
    const unread = items.filter((e) => !adminRead.includes(e.id));
    const shown = adminOnlyNew ? unread : items;
    // 날짜별로 묶는다(최신 날짜가 위). 서버가 최신순으로 주므로 순서를 유지.
    const days: { day: string; entries: AdminEntry[] }[] = [];
    for (const e of shown) {
      const day = entryDay(e);
      const g = days.find((d) => d.day === day);
      if (g) g.entries.push(e);
      else days.push({ day, entries: [e] });
    }
    const copyUnread = async () => {
      if (!unread.length) { setAdminMsg("미확인 피드백이 없습니다."); return; }
      const ok = await copyToClipboard(summarizeFeedbackForChat(unread));
      setAdminMsg(ok
        ? `미확인 ${unread.length}건을 클립보드에 복사했습니다 — 그대로 붙여넣으세요.`
        : "클립보드 복사에 실패했습니다.");
    };
    return (
      <>
        {gnb}
        {adminModal}
        <div className="shell admin-shell">
          <div className="admin-head">
            <h2>수집된 피드백{" "}
              <span className="admin-count">{adminData?.count ?? items.length}건</span>
              {unread.length > 0 &&
                <span className="admin-new">미확인 {unread.length}</span>}
            </h2>
            <div className="admin-head-actions">
              <label className="admin-filter">
                <input type="checkbox" checked={adminOnlyNew}
                       onChange={(e) => setAdminOnlyNew(e.target.checked)} />
                미확인만 보기
              </label>
              <button className="rm" onClick={copyUnread} disabled={adminBusy}
                      title="미확인 피드백 내용을 대화창에 붙여넣기 좋은 형태로 복사합니다">
                📋 미확인 복사</button>
              <button className="rm" disabled={adminBusy || !unread.length}
                      onClick={() => setEntriesRead(unread.map((e) => e.id), true)}>
                모두 확인 처리</button>
              <button className="rm"
                      onClick={() => submitAdmin()}
                      disabled={adminBusy}>새로고침</button>
              <button className="rm" onClick={() => setView("upload")}>닫기</button>
            </div>
          </div>
          {adminMsg && <p className="admin-msg">{adminMsg}</p>}
          {shown.length === 0 ? (
            <p className="admin-empty">
              {items.length === 0 ? "아직 수집된 피드백이 없습니다."
                                  : "미확인 피드백이 없습니다."}</p>
          ) : days.map(({ day, entries }) => {
            const closed = !!adminClosed[day];
            const dayUnread = entries.filter((e) => !adminRead.includes(e.id));
            return (
              <section className="admin-day" key={day}>
                <div className="admin-day-head">
                  <button type="button" className="admin-day-toggle"
                          onClick={() => setAdminClosed((c) =>
                            ({ ...c, [day]: !c[day] }))}>
                    {closed ? "▸" : "▾"} {day}
                    <span className="admin-count">{entries.length}건</span>
                    {dayUnread.length > 0 &&
                      <span className="admin-new">미확인 {dayUnread.length}</span>}
                  </button>
                  <span style={{ flex: 1 }} />
                  {dayUnread.length > 0 && (
                    <button type="button" className="rm" disabled={adminBusy}
                            onClick={() => setEntriesRead(
                              dayUnread.map((e) => e.id), true)}>
                      이 날짜 확인 처리</button>
                  )}
                </div>
                {!closed && entries.map(renderAdminEntry)}
              </section>
            );
          })}
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
                  {setCount}세트 · {loaded.length}건 분석 — 총 결함{" "}
                  {totalDefects
                    ? <b className="bad">{totalDefects}건</b>
                    : <b className="ok">0건</b>}
                  {loaded.some((r) => r.error) &&
                    <span className="err"> · 실패 {loaded.filter((r) => r.error).length}건</span>}
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
                                {fmtDateTime(analyzedAt)} ·{" "}
                                {g.items[0].item.instance != null
                                  ? `샘플 ${g.items.length}개`
                                  : `${g.items.length}장`}</span>)}
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
                            {pageLabel(item)}
                            {item.error ? " ⚠" : (() => {
                              const confirmed = item.defects?.filter(
                                (f) => f.type !== "texture_review").length ?? 0;
                              const review = item.defects?.filter(
                                (f) => f.type === "texture_review").length ?? 0;
                              if (confirmed) return ` · 결함 ${confirmed}`;
                              if (review) return ` · 재확인 ${review}`;
                              return " · 정상";
                            })()}
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
      {prepModal}
      {(prepPending || prepBusy) && (
        <div className="modal-back prep-wait" role="status" aria-live="polite">
          <div className="prep-wait-card">
            <span className="spin" />
            <h3>{prepPending ? "원본 데이터 확인 중…" : "원본 데이터 정제 적용 중…"}</h3>
            <p>처리가 끝날 때까지 다른 세트의 파일 입력을 잠시 잠급니다.<br />
               이 창은 완료되면 자동으로 닫힙니다.</p>
          </div>
        </div>
      )}
      {/* 검수 중에는 페이지 전체를 잠근다 — 버튼·드롭존이 실제로 비활성일 뿐
          아니라 마우스 커서도 '클릭 불가'로 바뀌어 한눈에 알 수 있게 한다. */}
      <div className={"shell" + (running ? " locked" : "")}>
        <div className="inspect">
          <aside className="artlib card">
            <div className="artlib-title">
              <span>공용 보관함</span>
              <button type="button" className="sec-add" disabled={running}
                      title={selectedSection
                        ? "선택한 폴더 아래에 하위 폴더를 만듭니다"
                        : "최상위 폴더를 만듭니다"}
                      onClick={() => setAddingSection(true)}>＋ 폴더</button>
            </div>
            {hasLibraryServer && (
              <div className="lib-tools">
                <span className="lib-sync-state"
                      {...tip("팀 전원이 어느 기기에서 열든 이 보관함 하나를 봅니다. 추가·삭제·폴더 정리는 자동으로 서버와 맞춰져요.")}>
                  {serverBusy ? "⟳ 동기화 중…"
                    : lastSync
                      ? `☁ 공용 · ${new Date(lastSync)
                          .toLocaleTimeString("ko-KR",
                            { hour: "2-digit", minute: "2-digit" })} 동기화`
                      : "☁ 공용 보관함"}
                </span>
                <button type="button" disabled={running || serverBusy}
                        onClick={() => doSync()}
                        {...tip("서버와 지금 바로 맞춥니다(평소에는 자동).")}>
                  동기화</button>
              </div>
            )}
            <div className="lib-tip-anchor">
              {hoverTip && <p className="lib-tip" role="tooltip">{hoverTip}</p>}
            </div>
            {libStatus && <p className="lib-status">{libStatus}</p>}
            {selectedSection && (
              <div className="sec-selbar">
                <span>선택됨: <b>{sections.find((s) => s.id === selectedSection)?.name}</b>
                  {" "}— ＋폴더는 이 아래에 생깁니다</span>
                <button type="button" onClick={() => setSelectedSection(null)}>해제</button>
              </div>
            )}
            {addingSection && (
              <div className="sec-edit">
                <input autoFocus value={sectionDraft}
                  placeholder={selectedSection ? "하위 폴더 이름" : "폴더 이름"}
                  onChange={(e) => setSectionDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onAddSection();
                    if (e.key === "Escape") { setAddingSection(false); setSectionDraft(""); }
                  }} />
                <button type="button" onClick={onAddSection}>확인</button>
              </div>
            )}
            {/* 폴더 트리 — 여기만 스크롤한다(제목·도구는 항상 보이게).
                빈 곳에 떨어뜨리면 최상위(미분류)로 간다. */}
            <div className={"artlib-tree" +
                   (dragOverSec === "" ? " dragover" : "") +
                   (libDropBusy ? " busy" : "")}
                 {...dropProps("")}>
              {recent.length === 0 && sections.length === 0 && (
                <p className="artlib-empty">
                  원본을 올리면 여기에 자동 저장됩니다.<br />
                  파일을 이 영역으로 끌어놓아도 저장돼요.<br />
                  폴더로 정리할 수 있어요.
                </p>
              )}
              {/* 최상위 폴더부터 재귀 렌더(하위는 renderSection 안에서) */}
              {sections.filter((s) => !s.parentId ||
                !sections.some((p) => p.id === s.parentId))
                .map((s) => renderSection(s, 0))}
              {/* 미분류 — 폴더가 있으면 항상 표시(드롭으로 되돌릴 수 있게) */}
              {(() => {
                const unfiled = recent.filter((a) =>
                  !a.section || !sections.some((s) => s.id === a.section));
                if (unfiled.length === 0 && sections.length === 0) return null;
                return (
                  <div className="sec-group">
                    {sections.length > 0 && <div className="sec-head plain">미분류</div>}
                    {unfiled.map(renderArtwork)}
                    {unfiled.length === 0 && sections.length > 0 && (
                      <div className="sec-empty">여기로 드래그하면 분류 해제</div>
                    )}
                  </div>
                );
              })()}
            </div>
            {libDropBusy && (
              <p className="lib-status"><span className="spin" /> 보관함에 저장 중…</p>
            )}
            {storageNote && <p className={"lib-storage" +
              (storageNote.warn ? " warn" : "")}>{storageNote.text}</p>}
          </aside>
          <div className="inspect-main">
            <div className="sets">
              {pairs.map((p, i) => {
                const rc = pageCount(p.ref), tc = pageCount(p.test);
                const bad = p.multi
                  ? (rc > 1 || tc > 1)
                  : rc > 0 && tc > 0 && rc !== tc;
                const okMatch = p.multi
                  ? rc === 1 && tc === 1
                  : rc > 0 && rc === tc;
                return (
                  <div className="pair card" key={p.id}>
                    <div className="pairhead">
                      <b>{p.name || `세트 ${i + 1}`}</b>
                      <label className="opt multi-opt"
                             title={"인쇄물 스캔 한 장에 같은 샘플이 여러 개 " +
                                    "찍혀 있으면 켜세요. 샘플 위치를 자동으로 " +
                                    "찾아 샘플별로 나눠 검수합니다."}>
                        <input type="checkbox" checked={!!p.multi}
                               disabled={editingLocked}
                               onChange={(e) => setPairs((ps) => ps.map((x) =>
                                 x.id === p.id
                                   ? { ...x, multi: e.target.checked } : x))} />
                        {" "}다중 샘플
                      </label>
                      {pairs.length > 1 && (
                        <button type="button" className="rm" disabled={editingLocked}
                                onClick={() => removePair(p.id)}>삭제</button>
                      )}
                    </div>
                    <div className="pairzones">
                      <MultiDropZone label="① 원본" entries={p.ref}
                        busy={!!converting[`${p.id}:ref`]} disabled={editingLocked}
                        onAdd={(fs) => addFiles(p.id, "ref", fs)}
                        onRemove={(n) => removeEntry(p.id, "ref", n)}
                        onReorder={(f, t) => reorderEntry(p.id, "ref", f, t)}
                        onAddArtwork={(h) => addArtworkToPair(p.id, "ref", h)} />
                      <MultiDropZone
                        label={p.multi ? "② 인쇄물 (샘플 여러 개 스캔 1장)"
                                       : "② 인쇄물"}
                        entries={p.test}
                        busy={!!converting[`${p.id}:test`]} disabled={editingLocked}
                        onAdd={(fs) => addFiles(p.id, "test", fs)}
                        onRemove={(n) => removeEntry(p.id, "test", n)}
                        onReorder={(f, t) => reorderEntry(p.id, "test", f, t)}
                        onAddArtwork={(h) => addArtworkToPair(p.id, "test", h)} />
                    </div>
                    {(rc > 0 || tc > 0) && (
                      <div className={"pairmatch" + (bad ? " bad" : okMatch ? " ok" : "")}>
                        {p.multi ? <>
                          원본 {rc}장 · 인쇄물 스캔 {tc}장
                          {okMatch && " · 샘플 수는 자동 검출 ✓"}
                          {bad && " · 다중 샘플은 원본 1장 + 스캔 1장이어야 합니다 ✗"}
                        </> : <>
                          원본 {rc}장 · 인쇄물 {tc}장
                          {okMatch && " · 매칭 ✓"}
                          {bad && " · 페이지 수가 다릅니다 ✗"}
                        </>}
                      </div>
                    )}
                  </div>
                );
              })}
              <button type="button" className="add card" disabled={editingLocked}
                      onClick={addPair}>
                + 세트 추가
              </button>
            </div>
            <div className="card runbar">
              <label className="opt">
                <input type="checkbox" checked={useOcr} disabled={editingLocked}
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
                        disabled={!allComplete || editingLocked}
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
