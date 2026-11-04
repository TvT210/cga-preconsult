"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
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
  }, [turns.length]);

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content || !session) return;
    setSending(true);
    setConflictNote([]);
    try {
      const reply = await api.post<DialogueReply>(
        `/dialogue/sessions/${session.id}/messages`,
        { content },
      );
      setInput("");
      setLastReply(reply.reply ?? "");
      if (reply.conflict_flags?.length) {
        setConflictNote(
          reply.conflict_flags.map(
            (flag) =>
              `${flag.field}：对话信息「${String(flag.dialogue_value ?? "")}」，量表结果「${String(
                flag.scale_value ?? "",
              )}」${flag.note ? `（${flag.note}）` : ""}`,
          ),
        );
      }
      const detail = await api.get<DialogueSession>(
        `/dialogue/sessions/${session.id}`,
      );
      setTurns(detail.turns ?? []);
    } catch {
      /* 错误提示已由 api 层统一处理 */
    } finally {
      setSending(false);
    }
  }, [input, session]);

  if (loading) {
    return <LoadingState label="正在打开对话…" />;
  }

  if (error) {
    return <ErrorState message={error} onRetry={() => void bootstrap()} />;
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="AI 健康对话"
        description="用平常的话说一说最近的身体情况就可以。对话助手只做信息收集，不会给出诊断或用药建议。"
      />

      <div className="rounded-xl2 border border-slate-200 bg-white p-5 shadow-card">
        <ol ref={listRef} className="max-h-[52vh] space-y-4 overflow-y-auto pr-1">
          {turns.length === 0 ? (
            <li className="rounded-xl bg-slate-50 px-4 py-3 text-elder text-ink-soft">
              您好，我是健康小助手。可以从最近哪里不舒服说起，比如「头晕三天了」。
            </li>
          ) : null}
          {turns.map((turn, position) => (
            <li
              key={`${turn.created_at ?? "t"}-${position}`}
              className={[
                "rounded-xl px-4 py-3 text-elder whitespace-pre-wrap",
                turn.role === "user"
                  ? "ml-8 bg-medical-700 text-white"
                  : "mr-8 border border-slate-200 bg-slate-50 text-ink",
              ].join(" ")}
            >
              {turn.content}
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
          ))}
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
          <BigButton size="lg" loading={sending} disabled={!input.trim()} onClick={() => void send()}>
            发送
          </BigButton>
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
