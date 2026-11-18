import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiError, streamDialogueMessage } from "@/lib/api";
import { TOKEN_KEY } from "@/lib/session";

/**
 * SSE 流式对话客户端测试（A-6）。
 *
 * `streamDialogueMessage` 手写了一套帧缓冲状态机：帧可能被切在任意两个 chunk 之间，
 * 代理还可能插入 `\r`、塞心跳注释行。这些分支出错时不会抛异常，只会让老人看到
 * 半截回复或少一段话，所以必须逐条钉住。
 */

const encoder = new TextEncoder();

/** 把若干段文本打包成一次 SSE 响应；分段方式就是服务端 chunk 的到达方式 */
function sseResponse(chunks: string[]): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "text/event-stream" },
  });
}

function stubFetch(response: Response): ReturnType<typeof vi.fn> {
  const fn = vi.fn(async () => response);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("streamDialogueMessage：正常路径", () => {
  it("增量按到达顺序回调，收尾事件返回与非流式一致的完整字段", async () => {
    stubFetch(
      sseResponse([
        'data: {"safety_note":"胸痛持续请立即拨打 120","done":false}\n\n',
        'data: {"reply":"您好，","done":false}\n\n',
        'data: {"reply":"我是健康小助手。","done":false}\n\n',
        'data: {"reply":"您好，我是健康小助手。","done":true,"disclaimer":"仅供参考","model":"mock"}\n\n',
      ]),
    );

    const deltas: string[] = [];
    const safety: string[] = [];
    const doneEvents: unknown[] = [];

    const result = await streamDialogueMessage(7, "我胸口疼", {
      onDelta: (piece) => deltas.push(piece),
      onSafety: (note) => safety.push(note),
      onDone: (event) => doneEvents.push(event),
    });

    expect(safety).toEqual(["胸痛持续请立即拨打 120"]);
    expect(deltas).toEqual(["您好，", "我是健康小助手。"]);
    expect(result?.reply).toBe("您好，我是健康小助手。");
    expect(result?.disclaimer).toBe("仅供参考");
    // 收尾事件走 onDone，不再重复走 onDelta
    expect(doneEvents).toHaveLength(1);
  });

  it("一帧被切在两个 chunk 之间时，缓冲要能拼回去", async () => {
    stubFetch(
      sseResponse([
        'data: {"reply":"请稍',
        '等，"}\n\ndata: {"reply":"请稍等，我在听。","done":true}\n\n',
      ]),
    );

    const deltas: string[] = [];
    const result = await streamDialogueMessage(1, "嗯", {
      onDelta: (piece) => deltas.push(piece),
    });

    expect(deltas).toEqual(["请稍等，"]);
    expect(result?.reply).toBe("请稍等，我在听。");
  });

  it("兼容 CRLF 分隔，并跳过心跳注释与非 JSON 的 data 行", async () => {
    stubFetch(
      sseResponse([
        ": ping\r\n\r\n",
        "data: keep-alive\r\n\r\n",
        'data: {"reply":"在","done":false}\r\n\r\n',
        'data: {"reply":"在的。","done":true}\r\n\r\n',
      ]),
    );

    const deltas: string[] = [];
    const result = await streamDialogueMessage(1, "在吗", {
      onDelta: (piece) => deltas.push(piece),
    });

    expect(deltas).toEqual(["在"]);
    expect(result?.reply).toBe("在的。");
  });

  it("请求带上 SSE 所需的头与登录态", async () => {
    window.localStorage.setItem(TOKEN_KEY, "token-abc");
    const fn = stubFetch(sseResponse(['data: {"reply":"好","done":true}\n\n']));

    await streamDialogueMessage(42, "你好");

    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/dialogue/sessions/42/messages/stream");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Accept).toBe("text/event-stream");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-abc");
    expect(init.body).toBe(JSON.stringify({ content: "你好" }));
  });
});

describe("streamDialogueMessage：异常与中断", () => {
  it("流正常结束却没收到收尾事件时报错，绝不把半截回复当完整结果", async () => {
    // 每次调用都要新建 Response：流被读过一次就锁住了，不能复用同一个对象
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => sseResponse(['data: {"reply":"说到一半","done":false}\n\n'])),
    );

    await expect(streamDialogueMessage(1, "继续")).rejects.toBeInstanceOf(ApiError);
    await expect(streamDialogueMessage(1, "继续")).rejects.toThrow("对话中断");
  });

  it("HTTP 错误时抛出后端给的 message，而不是状态码", async () => {
    stubFetch(
      new Response(JSON.stringify({ message: "会话不存在" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );

    await expect(streamDialogueMessage(1, "你好")).rejects.toThrow("会话不存在");
  });

  it("主动中断（fetch 被 abort）返回 null，不弹错误——点停止是正常操作", async () => {
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new DOMException("aborted", "AbortError");
      }),
    );

    await expect(
      streamDialogueMessage(1, "你好", {}, controller.signal),
    ).resolves.toBeNull();
  });

  it("读到一半被中断时返回 null，已回调的增量保留给调用方决定怎么展示", async () => {
    const controller = new AbortController();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(encoder.encode('data: {"reply":"说到一半","done":false}\n\n'));
      },
      pull(c) {
        controller.abort();
        c.error(new DOMException("aborted", "AbortError"));
      },
    });
    stubFetch(new Response(stream, { status: 200 }));

    const deltas: string[] = [];
    const result = await streamDialogueMessage(
      1,
      "你好",
      { onDelta: (piece) => deltas.push(piece) },
      controller.signal,
    );

    expect(result).toBeNull();
    expect(deltas).toEqual(["说到一半"]);
  });
});
