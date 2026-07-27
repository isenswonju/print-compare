// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flushFbQueue, loadFbQueue, saveFbQueue, trySendFeedback,
  type FeedbackPayload,
} from "./lib.ts";

// jsdom hostname은 localhost → computeFeedbackEndpoints가 ["/feedback"]을 준다.
const payload = (n: number): FeedbackPayload =>
  ({ app: "x", version: "v", sentAt: "t", origin: "o", items: [{ i: n }] });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("피드백 보류 큐 (서버 꺼져 있을 때 브라우저 보관)", () => {
  it("saveFbQueue → loadFbQueue 왕복", () => {
    expect(saveFbQueue([payload(1), payload(2)])).toBe(true);
    const q = loadFbQueue();
    expect(q).toHaveLength(2);
    expect(q[0].items[0]).toEqual({ i: 1 });
  });
  it("빈 큐 저장은 키를 지운다", () => {
    saveFbQueue([payload(1)]);
    saveFbQueue([]);
    expect(loadFbQueue()).toEqual([]);
    expect(localStorage.getItem("artwork-fb-queue")).toBeNull();
  });
  it("손상된 localStorage는 빈 큐로 폴백", () => {
    localStorage.setItem("artwork-fb-queue", "{망가진 json");
    expect(loadFbQueue()).toEqual([]);
  });
});

describe("trySendFeedback (서버 전송)", () => {
  it("서버 200이면 전송된 엔드포인트 URL을 반환", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);
    expect(await trySendFeedback(payload(1))).toBe("/feedback");
    expect(fetchMock).toHaveBeenCalledWith("/feedback", expect.objectContaining({
      method: "POST",
      headers: { "Content-Type": "application/json" },
    }));
  });
  it("서버가 실패(4xx/5xx)면 null", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await trySendFeedback(payload(1))).toBeNull();
  });
  it("네트워크 예외도 삼켜 null 반환(전송 시도 자체가 앱을 깨면 안 됨)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("net down")));
    expect(await trySendFeedback(payload(1))).toBeNull();
  });
});

describe("flushFbQueue (다음 방문 시 자동 재전송)", () => {
  it("전송 성공분은 큐에서 비운다", async () => {
    saveFbQueue([payload(1), payload(2)]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    expect(await flushFbQueue()).toBe(2);
    expect(loadFbQueue()).toEqual([]);
  });
  it("전송 실패분은 큐에 남겨 다음에 재시도", async () => {
    saveFbQueue([payload(1)]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    expect(await flushFbQueue()).toBe(0);
    expect(loadFbQueue()).toHaveLength(1);
  });
  it("빈 큐면 0 (네트워크 호출 없음)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await flushFbQueue()).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
