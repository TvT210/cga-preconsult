"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, streamDialogueMessage } from "@/lib/api";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { formatDateTime } from "@/lib/format";
import type {
  DialogueReply,
  DialogueSession,
  DialogueTurn,
} from "@/lib/types";
import { BigButton } from "@/components/BigButton";
import { ErrorState, LoadingState } from "@/components/ErrorState";
import { PageHeader } from "@/components/PageHeader";
import { VoiceBar } from "@/components/VoiceBar";

/** 界面上临时插入的气泡：还没被服务端回填的那一轮 */
type TransientTurn = DialogueTurn & { transient: "pending" | "streaming" };

function isTransient(turn: DialogueTurn | TransientTurn): turn is TransientTurn {
  return "transient" in turn;
}

export default function ElderChatPage() {
  const { user } = useCurrentUser();
  // patient_id 保持后端原样（整数主键）：请求体按原类型发送
  const patientId = user?.patient_id ?? null;

  const [session, setSession] = useState<DialogueSession | null>(null);
  const [turns, setTurns] = useState<DialogueTurn[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [rate, setRate] = useState(0.9);
  const [lastReply, setLastReply] = useState("");
  const [conflictNote, setConflictNote] = useState<string[]>([]);
  const listRef = useRef<HTMLOListElement | null>(null);

  // ---- 流式（A-7）----
  /** 已发出、服务端尚未回填的用户消息 */
  const [pendingUser, setPendingUser] = useState("");
  /** 正在逐字显示的回复 */
  const [streamingText, setStreamingText] = useState("");
  /** 流式期间前置到达的急症提示（早于正文，必须马上显示） */
  const [streamNote, setStreamNote] = useState("");
  const [phase, setPhase] = useState<"idle" | "streaming" | "stopped">("idle");
  const abortRef = useRef<AbortController | null>(null);

  /** 建立会话并载入历史对话 */
  const bootstrap = useCallback(async () => {
    if (patientId === null || patientId === "") {
      setError("当前账号没有绑定老人档案，请联系工作人员。");
      setLoading(false);
      return;
    }
    setLoading(true);
    setError("");
    try {
      const created = await api.post<DialogueSession>("/dialogue/sessions", {
        patient_id: patientId,
      });
      setSession(created);
      if (created?.id) {
        const detail = await api.get<DialogueSession>(
          `/dialogue/sessions/${created.id}`,
        );
        setTurns(detail.turns ?? []);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "暂时无法连接对话服务，请稍后重试或联系工作人员。",
      );
    } finally {
      setLoading(false);
    }
  }, [patientId]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [turns.length, streamingText]);

  /** 拉一次服务端会话，把本地临时气泡换成真实记录 */
  const refreshTurns = useCallback(async (sessionId: string | number) => {
    try {
      const detail = await api.get<DialogueSession>(
        `/dialogue/sessions/${sessionId}`,
      );
      setTurns(detail.turns ?? []);
    } catch {
      /* 刷新失败不影响已经显示的内容 */
    }
  }, []);

  /** 清掉临时气泡 */
  const clearTransient = useCallback(() => {
    setPendingUser("");
    setStreamingText("");
    setStreamNote("");
    setPhase("idle");
  }, []);

  /** 老人点「停止」：只断本地的流；服务端会把已说出的部分落库并标记中断 */
  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content || !session || sending) return;

    // 上一轮被停止过：服务端可能已经把说到一半的内容落库，
    // 发新消息前先对齐一次，免得下次刷新时凭空多出一段。
    if (phase === "stopped") {
      await refreshTurns(session.id);
      clearTransient();
    }

    setSending(true);
    setConflictNote([]);
    setStreamNote("");
    setStreamingText("");
    setPendingUser(content);
    setPhase("streaming");
    setInput("");

    const controller = new AbortController();
    abortRef.current = controller;
    let accumulated = "";

    const applyReply = (reply: DialogueReply) => {
      setLastReply(reply.reply ?? "");
      setConflictNote(
        (reply.conflict_flags ?? []).map(
          (flag) =>
            `${flag.field}：对话信息「${String(flag.dialogue_value ?? "")}」，量表结果「${String(
              flag.scale_value ?? "",
            )}」${flag.note ? `（${flag.note}）` : ""}`,
        ),
      );
    };

    try {
      const final = await streamDialogueMessage(
        session.id,
        content,
        {
          onDelta: (piece) => {
            accumulated += piece;
            setStreamingText(accumulated);
          },
          onSafety: (note) => setStreamNote(note),
        },
        controller.signal,
      );

      if (!final) {
        // 主动停止：保留已经显示的内容，等服务端落库后下次再对齐
        setPhase("stopped");
        return;
      }

      applyReply(final);
      await refreshTurns(session.id);
      clearTransient();
    } catch (err) {
      // 端点不存在或服务端出错时退化为一次性请求，保证对话仍能继续
      const status = err instanceof ApiError ? err.status : 0;
      const canFallback =
        !accumulated && (status === 404 || status === 405 || status >= 500);
      if (canFallback) {
        try {
          const reply = await api.post<DialogueReply>(
            `/dialogue/sessions/${session.id}/messages`,
            { content },
          );
          applyReply(reply);
          await refreshTurns(session.id);
          clearTransient();
          return;
        } catch {
          /* 降级也失败，继续走兜底 */
        }
      }
      if (accumulated) {
        // 已经说出一部分：保留下来并标成中断，不假装是完整回复
        setPhase("stopped");
      } else {
        clearTransient();
        setInput(content); // 把话还回输入框，老人不用重打
      }
    } finally {
      abortRef.current = null;
      setSending(false);
    }
  }, [input, session, sending, phase, refreshTurns, clearTransient]);

  if (loading) {
    return <LoadingState label="正在打开对话…" />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={() => void bootstrap()} />;
  }

  // 历史记录 + 这一轮还没回填的临时气泡合成一条列表：服务端返回后整体替换，
  // 老人不会看到「先说了一大段又消失」的空窗。
  const transientTurns: TransientTurn[] = [];
  if (pendingUser) {
    transientTurns.push({
      role: "user",
      content: pendingUser,
      transient: "pending",
    });
  }
  if (phase !== "idle") {
    transientTurns.push({
      role: "assistant",
      content: streamingText,
      safety_note: streamNote || undefined,
      transient: "streaming",
    });
  }
  const displayTurns: (DialogueTurn | TransientTurn)[] = [
    ...turns,
    ...transientTurns,
  ];

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI 健康对话"
        description="用平常的话说一说最近的身体情况就可以。对话助手只做信息收集，不会给出诊断或用药建议。"
      />

      <div className="rounded-xl2 border border-slate-200 bg-white p-5 shadow-card">
        <ol ref={listRef} className="max-h-[52vh] space-y-4 overflow-y-auto pr-1">
          {displayTurns.length === 0 ? (
            <li className="rounded-xl bg-slate-50 px-4 py-3 text-elder text-ink-soft">
              您好，我是健康小助手。可以从最近哪里不舒服说起，比如「头晕三天了」。
            </li>
          ) : null}
          {displayTurns.map((turn, position) => {
            const transient = isTransient(turn) ? turn.transient : null;
            // 「没说完」的回复要明确标出来，不能让老人和医护以为这就是完整回答
            const broken =
              turn.role === "assistant" &&
              (Boolean(turn.extracted?.interrupted) ||
                (transient === "streaming" && phase === "stopped"));
            const waiting =
              transient === "streaming" && phase === "streaming" && !turn.content;
            return (
              <li
                key={
                  transient
                    ? `transient-${transient}`
                    : `${turn.created_at ?? "t"}-${position}`
                }
                className={[
                  "rounded-xl px-4 py-3 text-elder whitespace-pre-wrap",
                  turn.role === "user"
                    ? "ml-8 bg-medical-700 text-white"
                    : "mr-8 border border-slate-200 bg-slate-50 text-ink",
                ].join(" ")}
              >
                {turn.content}
                {waiting ? (
                  <span className="text-ink-soft">正在回复…</span>
                ) : null}
                {broken ? (
                  <p className="mt-2 text-elder text-ink-mute">
                    （这条回复没有说完，已按原样记录）
                  </p>
                ) : null}
                {turn.safety_note ? (
                  <p className="mt-2 rounded-lg bg-amber-100 px-3 py-2 text-elder text-amber-900">
                    安全提示：{turn.safety_note}
                  </p>
                ) : null}
                {turn.created_at ? (
                  <p
                    className={
                      turn.role === "user"
                        ? "mt-1 text-right text-elder text-medical-100"
                        : "mt-1 text-elder text-ink-mute"
                    }
                  >
                    {formatDateTime(turn.created_at)}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      </div>

      {conflictNote.length ? (
        <div className="rounded-xl2 border-2 border-amber-300 bg-amber-50 p-4">
          <p className="text-elder font-semibold text-amber-900">
            以下信息与量表结果不一致，已交由医护人员复核
          </p>
          <ul className="mt-2 list-disc pl-6 text-elder text-amber-900">
            {conflictNote.map((note, position) => (
              <li key={position}>{note}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <VoiceBar
        speechText={lastReply}
        rate={rate}
        onRateChange={setRate}
        allowInput
        onTranscript={(text) => setInput((prev) => (prev ? `${prev} ${text}` : text))}
      />

      <div className="card card-pad space-y-3">
        <label className="field-label" htmlFor="chat-input">
          想说的话
        </label>
        <textarea
          id="chat-input"
          className="field-input min-h-[120px] w-full resize-y"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder="例如：这两天走路有点没劲，晚上睡不踏实"
        />
        <div className="flex flex-wrap gap-3">
          {sending ? (
            // 回复太长、或老人不想听了，要能立刻停下来
            <BigButton variant="ghost" size="lg" onClick={stop}>
              停止
            </BigButton>
          ) : (
            <BigButton
              size="lg"
              disabled={!input.trim()}
              onClick={() => void send()}
            >
              发送
            </BigButton>
          )}
          <BigButton
            variant="ghost"
            size="lg"
            disabled={!input.trim() || sending}
            onClick={() => setInput("")}
          >
            清空
          </BigButton>
        </div>
        <p className="text-elder text-ink-mute">
          对话内容会记录到您的健康档案，供医生参考。结果仅供参考，不构成诊断，请及时咨询医生。
        </p>
      </div>
    </div>
  );
}
