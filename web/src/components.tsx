// UI 부품: 드롭존(썸네일), 오버레이 검사기(결함 한정 확대경 + 피드백 진입),
// 피드백 팝업(확대 포함), 세트 결과 상세.
import React, { useEffect, useRef, useState } from "react";
import { LENS_H, LENS_W, displayCsv, download, drawLensInto,
         sevCounts, viewportPanelPosition } from "./lib.ts";
import type { DispFinding, FileEntry, MissedFb, ResultItem,
              SetFb } from "./types.ts";

function FileThumb({ entry }: { entry: FileEntry }) {
  const source = entry.pages[0] || entry.file;
  const [src, setSrc] = useState("");
  useEffect(() => {
    const url = URL.createObjectURL(source);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [source]);
  return <img className="fe-thumb" src={src} alt="" aria-hidden="true" />;
}

// ---------------------------------------------------------------- 다중 드롭존
// 여러 파일(이미지/PDF)을 받는다. PDF는 페이지 수만큼 펼쳐지며, 총 페이지 수를
// 배지로 보여준다(원본 2장 PDF ↔ 인쇄물 2장 매칭 등).
export function MultiDropZone({ label, entries, busy, disabled,
                               onAdd, onRemove, onReorder, onAddArtwork }: {
  label: string;
  entries: FileEntry[];
  busy?: boolean;
  disabled?: boolean;         // 검수 중에는 편집을 완전히 잠근다
  onAdd: (files: File[]) => void;
  onRemove: (name: string) => void;
  onReorder?: (from: number, to: number) => void;  // 목록 내 드래그 재정렬
  onAddArtwork?: (hash: string) => void;            // 보관함에서 드래그 투입
}) {
  const [over, setOver] = useState(false);
  const [dragIdx, setDragIdx] = useState<number | null>(null); // 재정렬 중 파일 인덱스
  const [overIdx, setOverIdx] = useState<number | null>(null); // 드롭 위치 표시
  const inp = useRef<HTMLInputElement>(null);
  const total = entries.reduce((s, e) => s + e.pages.length, 0);
  const has = entries.length > 0;

  const openPicker = () => { if (!disabled) inp.current?.click(); };

  return (
    <div
      className={"drop multi" + (over ? " over" : "") + (has ? " ok" : "") +
                 (disabled ? " locked" : "")}
      role="button" tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onClick={openPicker}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openPicker();
        }
      }}
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault(); setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        setOver(false);
        // 보관함 아트웍(text/hash) 우선 처리 — 파일 드롭이 아니면 투입.
        const hash = e.dataTransfer.getData("text/hash");
        if (hash && onAddArtwork) { onAddArtwork(hash); return; }
        if (e.dataTransfer.files.length) onAdd([...e.dataTransfer.files]);
      }}
    >
      <div className="drop-head">
        <b>{label}</b>
        {total > 0 && <span className="pagebadge">{total}장</span>}
      </div>
      {has && (
        <ul className="filelist" onClick={(e) => e.stopPropagation()}>
          {entries.map((en, i) => (
            <li key={en.name}
                className={"fileentry" + (!disabled && onReorder ? " reorderable" : "") +
                           (overIdx === i && dragIdx !== null ? " dropbefore" : "")}
                draggable={!disabled && !!onReorder}
                onDragStart={(e) => {
                  if (disabled || !onReorder) return;
                  setDragIdx(i);
                  e.dataTransfer.effectAllowed = "move";
                  // 재정렬 전용 마커 — 보관함 드롭(text/hash)과 구분.
                  e.dataTransfer.setData("text/reorder", String(i));
                }}
                onDragOver={(e) => {
                  if (disabled || dragIdx === null) return;
                  e.preventDefault(); e.stopPropagation();
                  e.dataTransfer.dropEffect = "move";
                  setOverIdx(i);
                }}
                onDrop={(e) => {
                  if (disabled || dragIdx === null || !onReorder) return;
                  e.preventDefault(); e.stopPropagation();
                  if (dragIdx !== i) onReorder(dragIdx, i);
                  setDragIdx(null); setOverIdx(null); setOver(false);
                }}
                onDragEnd={() => { setDragIdx(null); setOverIdx(null); }}>
              {!disabled && onReorder &&
                <span className="fe-grip" title="드래그해서 순서 변경">⠿</span>}
              <FileThumb entry={en} />
              <span className="fe-name" title={en.name}>{en.name}</span>
              {!disabled && (
                <button type="button" className="fe-rm" aria-label="제거"
                        onClick={() => onRemove(en.name)}>✕</button>
              )}
            </li>
          ))}
        </ul>
      )}
      {busy ? (
        <div className="drop-hint"><span className="spin" /> PDF 변환 중…</div>
      ) : disabled ? (
        <div className="drop-hint">검수 중에는 편집할 수 없습니다</div>
      ) : (
        <div className="drop-hint">
          {has ? "＋ 파일 추가" : "클릭 또는 드래그"}
          <span className="hint">PNG / JPG / PDF · 보관함에서 끌어놓기 가능</span>
        </div>
      )}
      <input
        ref={inp}
        type="file"
        accept=".png,.jpg,.jpeg,.pdf,application/pdf"
        multiple
        hidden
        disabled={disabled}
        onChange={(e) => {
          if (e.target.files?.length) onAdd([...e.target.files]);
          e.target.value = ""; // 같은 파일 다시 추가 가능하게
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------- 오버레이 검사기
const HIT_PAD = 40; // 결함 bbox 히트 판정 여유(원본 px) — 작은 결함도 짚기 쉽게

export type ModalState =
  | { kind: "defect"; f: DispFinding }
  | { kind: "missed"; x: number; y: number; idx: number | null };

export function OverlayInspector({ annotated, refCanvas, alignedCanvas, defects,
                                   missed, onDefectClick, onMissedClick }: {
  annotated: HTMLCanvasElement;
  refCanvas: HTMLCanvasElement;
  alignedCanvas: HTMLCanvasElement;
  defects: DispFinding[];
  missed: MissedFb[];
  onDefectClick: (f: DispFinding) => void;
  onMissedClick: (x: number, y: number, idx: number | null) => void;
}) {
  const wrap = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const refLens = useRef<HTMLCanvasElement>(null);
  const testLens = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (wrap.current && annotated) {
      annotated.className = "page";
      annotated.style.display = "block";
      wrap.current.replaceChildren(annotated);
    }
  }, [annotated]);

  const toFull = (e: React.MouseEvent) => {
    const rect = annotated.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width;
    const fy = (e.clientY - rect.top) / rect.height;
    return { X: fx * refCanvas.width, Y: fy * refCanvas.height, rect,
             px: e.clientX - rect.left, py: e.clientY - rect.top,
             inside: fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1 };
  };

  const hitDefect = (X: number, Y: number) =>
    defects.find((f) => {
      const [x, y, w, h] = f.bbox_ref;
      return X >= x - HIT_PAD && X <= x + w + HIT_PAD &&
             Y >= y - HIT_PAD && Y <= y + h + HIT_PAD;
    });

  const hide = () => { if (panel.current) panel.current.style.display = "none"; };

  const move = (e: React.MouseEvent) => {
    if (!annotated || !refCanvas) return;
    const { X, Y, inside } = toFull(e);
    if (!inside) return hide();
    const f = hitDefect(X, Y);
    annotated.style.cursor = f ? "pointer" : "crosshair";
    if (!f) return hide();
    // 결함 위에서 커서를 움직이면 확대 시야도 같은 좌표를 따라간다.
    drawLensInto(refCanvas, refLens.current, X, Y, f.bbox_ref);
    drawLensInto(alignedCanvas, testLens.current, X, Y, f.bbox_ref);
    const p = panel.current!;
    p.style.display = "block";
    const pos = viewportPanelPosition(
      e.clientX, e.clientY, p.offsetWidth, p.offsetHeight,
      document.documentElement.clientWidth, window.innerHeight,
    );
    p.style.left = pos.left + "px";
    p.style.top = pos.top + "px";
  };

  const click = (e: React.MouseEvent) => {
    if (!annotated || !refCanvas) return;
    const { X, Y, inside } = toFull(e);
    if (!inside) return;
    const f = hitDefect(X, Y);
    if (f) onDefectClick(f);
    else onMissedClick(Math.round(X), Math.round(Y), null);
  };

  return (
    <div style={{ position: "relative" }} onMouseMove={move}
         onMouseLeave={hide} onClick={click}>
      <div ref={wrap} />
      {missed.map((m, i) => (
        <div key={i} className="missmark"
             style={{ left: (m.x / refCanvas.width) * 100 + "%",
                      top: (m.y / refCanvas.height) * 100 + "%" }}
             title={m.comment || "미검출 피드백"}
             onClick={(e) => { e.stopPropagation(); onMissedClick(m.x, m.y, i); }}>
          M{i + 1}
        </div>
      ))}
      <div ref={panel} className="lens" style={{ display: "none" }}>
        <div className="lbl">REF (원본 배율)</div>
        <canvas ref={refLens} width={LENS_W} height={LENS_H} />
        <div className="lbl test">TEST</div>
        <canvas ref={testLens} width={LENS_W} height={LENS_H} />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 피드백 팝업
// 원인 분류는 오탐 튜닝의 핵심 라벨이므로 선택지를 제공한다.
const DEFECT_CAUSES = ["스캔 노이즈/먼지", "망점·인쇄 질감",
  "재단선/자연스러운 차이", "뒷비침", "정합 어긋남", "잘 모름/기타"];
const MISSED_TYPES = ["잉여 잉크/오염", "인쇄 누락", "글자 오류",
  "위치 밀림", "잘 모름/기타"];

export function FeedbackModal({ modal, item, onClose, onSave, onDelete }: {
  modal: ModalState;
  item: ResultItem;
  onClose: () => void;
  onSave: (v: { fp: boolean; cause: string; comment: string }) => void;
  onDelete: () => void;
}) {
  const refLens = useRef<HTMLCanvasElement>(null);
  const testLens = useRef<HTMLCanvasElement>(null);
  const existing = modal.kind === "defect"
    ? item.fb?.defects?.[modal.f.id]
    : modal.idx != null ? item.fb?.missed?.[modal.idx] : null;
  const causes = modal.kind === "defect" ? DEFECT_CAUSES : MISSED_TYPES;
  const [fp, setFp] = useState(existing && "fp" in existing ? existing.fp : true);
  const [cause, setCause] = useState(existing?.cause || causes[0]);
  const [comment, setComment] = useState(existing ? existing.comment : "");

  useEffect(() => {
    const [cx, cy] = modal.kind === "defect"
      ? [modal.f.bbox_ref[0] + modal.f.bbox_ref[2] / 2,
         modal.f.bbox_ref[1] + modal.f.bbox_ref[3] / 2]
      : [modal.x, modal.y];
    const box = modal.kind === "defect" ? modal.f.bbox_ref : null;
    const mark = modal.kind === "missed" ? { x: modal.x, y: modal.y } : null;
    drawLensInto(item.refCanvas ?? null, refLens.current, cx, cy, box, mark);
    drawLensInto(item.alignedCanvas ?? null, testLens.current, cx, cy, box, mark);
  }, [modal, item]);

  const title = modal.kind === "defect"
    ? `#${modal.f.id} ${modal.f.disp.ktype} [${modal.f.disp.severity.toUpperCase()}] 피드백`
    : `미검출 위치 피드백 (${modal.x}, ${modal.y})`;

  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h3>{title}</h3>
        <div className="lbl">REF (원본 배율)</div>
        <canvas ref={refLens} width={LENS_W} height={LENS_H} />
        <div className="lbl test">TEST</div>
        <canvas ref={testLens} width={LENS_W} height={LENS_H} />
        {modal.kind === "defect" && (
          <label className="opt" style={{ marginTop: 10 }}>
            <input type="checkbox" checked={fp}
                   onChange={(e) => setFp(e.target.checked)} />{" "}
            오탐입니다 (실제 결함이 아님)
          </label>
        )}
        <label className="opt">
          {modal.kind === "defect" ? "오탐 원인: " : "결함 유형: "}
          <select value={cause} onChange={(e) => setCause(e.target.value)}>
            {causes.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </label>
        <textarea
          placeholder={modal.kind === "defect"
            ? "간단한 피드백 (예: 스캔 먼지임, 실제 결함 아님)"
            : "무엇을 못 잡았는지 간단히 (예: 이 위치 글자 흐림 미검출)"}
          value={comment}
          onChange={(e) => setComment(e.target.value)}
        />
        <div className="modal-btns">
          {modal.kind === "missed" && modal.idx != null && (
            <button type="button" className="rm" onClick={onDelete}>삭제</button>
          )}
          <span style={{ flex: 1 }} />
          <button type="button" className="rm" onClick={onClose}>취소</button>
          <button type="button" className="go save"
                  onClick={() => onSave({ fp, cause, comment })}>저장</button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- 세트 결과 상세
// 피드백 모달은 상위(결과 페이지)가 소유한다 — 사이드바에서도 열 수 있도록.
export function ResultDetail({ item, onOpenModal }: {
  item: ResultItem;
  onOpenModal: (m: ModalState) => void;
}) {
  if (item.error)
    return <p className="err">분석 실패: {item.error}</p>;
  const { result, defects, annotated, refCanvas, alignedCanvas } = item;
  if (!result || !defects || !annotated || !refCanvas || !alignedCanvas)
    return null;
  const fb: SetFb = item.fb || { defects: {}, missed: [] };
  const reviews = defects.filter((f) => f.type === "texture_review");
  const confirmed = defects.filter((f) => f.type !== "texture_review");
  const n = sevCounts(confirmed);
  const base = item.name.replace(/[^\w가-힣.-]+/g, "_");

  return (
    <div>
      <p className="summary">
        {confirmed.length ? (
          <>결함 <b className="bad">{confirmed.length}건</b> 검출
            {" ("}
            {(["critical", "major", "minor"] as const)
              .filter((s) => n[s] > 0)
              .map((s) => `${s.toUpperCase()} ${n[s]}`)
              .join(" · ")}
            {")"}</>
        ) : (
          <b className="ok">결함이 검출되지 않았습니다.</b>
        )}
        {reviews.length > 0 && <> · 재확인 필요 <b>{reviews.length}건</b></>}{" "}
        · 분석 {((result.wallMs ?? 0) / 1000).toFixed(1)}초
      </p>
      <p className="dl">
        <a href="#" onClick={(e) => { e.preventDefault();
          download(`검수결과_${base}.csv`, new Blob([displayCsv(defects, fb)],
            { type: "text/csv" })); }}>결과표 CSV</a>
        <a href="#" onClick={(e) => { e.preventDefault();
          annotated.toBlob((b) => b && download(`오버레이_${base}.png`, b)); }}>
          오버레이 PNG</a>
      </p>
      {defects.length > 0 && (
        <table>
          <thead>
            <tr><th>#</th><th>유형</th><th>심각도</th><th>비고</th><th>피드백</th></tr>
          </thead>
          <tbody>
            {defects.map((f) => {
              const v = fb.defects[f.id];
              return (
                <tr key={f.id} className="clickable"
                    onClick={() => onOpenModal({ kind: "defect", f })}>
                  <td>{f.id}</td>
                  <td>{f.disp.ktype}</td>
                  <td><span className={"sev " + f.disp.severity}>
                    {f.type === "texture_review" ? "확인" : f.disp.severity.toUpperCase()}
                  </span></td>
                  <td>{f.disp.note}</td>
                  <td>{v ? (
                    <><span className={"fbbadge" + (v.fp ? " fp" : "")}>
                      {v.fp ? "오탐" : "의견"}</span> {v.comment}</>
                  ) : ""}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <h2>결함 위치 오버레이</h2>
      <p className="note">
        결함(빨간 박스)이나 재확인 후보(주황 박스) 위에 마우스를 올리면 커서를
        따라 확대되고, 클릭하면 피드백을 남길 수 있습니다. 검수기가 못 잡은
        곳은 그 위치를 클릭해 미검출 피드백을 남겨주세요.
      </p>
      <OverlayInspector
        annotated={annotated} refCanvas={refCanvas}
        alignedCanvas={alignedCanvas} defects={defects}
        missed={fb.missed}
        onDefectClick={(f) => onOpenModal({ kind: "defect", f })}
        onMissedClick={(x, y, idx) => onOpenModal({ kind: "missed", x, y, idx })}
      />
    </div>
  );
}
