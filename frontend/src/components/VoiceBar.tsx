"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  canRecognizeSpeech,
  canSpeak,
  getSpeechRecognition,
  listVoices,
  onVoicesChanged,
  speakText,
  stopSpeaking,
  type SpeechRecognitionInstance,
  type VoiceOption,
} from "@/lib/speech";
import { RATE_MAX, RATE_MIN } from "@/lib/elderPrefs";
import { useElderPrefs } from "./ElderPrefs";
import { BigButton } from "./BigButton";
import { useToast } from "./Toast";

const STEP = 0.1;

export interface VoiceBarProps {
  /** 需要朗读的内容（当前题目与选项 / 上一条回复） */
  speechText: string;
  /** 语音输入识别结果 */
  onTranscript?: (text: string) => void;
  /** 是否允许语音输入（部分页面无输入框时关闭） */
  allowInput?: boolean;
  className?: string;
  /** 吸顶常驻（量表页用）：滚动时朗读按钮始终可点 */
  sticky?: boolean;
}

/** 人声名太长（如 Microsoft Huihui - Chinese (Simplified)），列表里只显示前段 */
function shortVoiceLabel(name: string): string {
  return name.replace(/^Microsoft |^Google /, "").split(/[-–(]/)[0].trim() || name;
}

/**
 * 语音条：朗读当前内容（可重复播放、语速可调、可换人声）+ 语音输入。
 *
 * A-9 起语速与人声**记在老人偏好里**（跨题、跨页面沿用），不再由调用方传 state：
 * 老人调过一次「慢一点」，翻到下一题不该又变回默认速度。
 * 浏览器不支持时优雅降级：隐藏对应按钮并提示手动输入。
 */
export function VoiceBar({
  speechText,
  onTranscript,
  allowInput = true,
  className = "",
  sticky = false,
}: VoiceBarProps) {
  const toast = useToast();
  const { prefs, ready, nudgeRate, setVoiceName, setAutoSpeak } = useElderPrefs();
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [expanded, setExpanded] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
  const lastAutoRef = useRef("");
  const supportSpeak = canSpeak();
  const supportInput = canRecognizeSpeech();

  useEffect(() => {
    return () => {
      stopSpeaking();
      try {
        recognitionRef.current?.abort();
      } catch {
        /* 忽略 */
      }
    };
  }, []);

  // 音色列表可能异步到达：先取一次，再监听 voiceschanged 更新
  useEffect(() => {
    if (!supportSpeak) return;
    const sync = () => setVoices(listVoices());
    sync();
    return onVoicesChanged(sync);
  }, [supportSpeak]);

  const handleSpeak = useCallback(() => {
    if (!supportSpeak) {
      toast("当前浏览器不支持语音播报，请阅读屏幕文字。", "warning");
      return;
    }
    const ok = speakText(speechText, { rate: prefs.rate, voiceName: prefs.voiceName });
    if (ok) {
      setSpeaking(true);
      window.setTimeout(() => setSpeaking(false), Math.max(1500, speechText.length * 260));
    } else {
      toast("语音播报启动失败，请阅读屏幕文字。", "warning");
    }
  }, [speechText, prefs.rate, prefs.voiceName, supportSpeak, toast]);

  // 自动朗读：内容换了才读，同一道题重渲染不会重复念
  useEffect(() => {
    if (!prefs.autoSpeak || !ready || !supportSpeak || !speechText) return;
    if (lastAutoRef.current === speechText) return;
    lastAutoRef.current = speechText;
    speakText(speechText, { rate: prefs.rate, voiceName: prefs.voiceName });
  }, [prefs.autoSpeak, prefs.rate, prefs.voiceName, ready, speechText, supportSpeak]);

  const handleStop = useCallback(() => {
    stopSpeaking();
    setSpeaking(false);
    // 停过之后同一句话还能再点「朗读」，不用换题才生效
    lastAutoRef.current = speechText;
  }, [speechText]);

  const startRecognition = useCallback(() => {
    if (!supportInput) return;
    if (listening) {
      try {
        recognitionRef.current?.stop();
      } catch {
        /* 忽略 */
      }
      return;
    }
    const Ctor = getSpeechRecognition();
    if (!Ctor) return;
    try {
      const recognition = new Ctor();
      recognition.lang = "zh-CN";
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.onresult = (event) => {
        const results = event.results;
        let text = "";
        for (let i = 0; i < results.length; i += 1) {
          const item = results[i];
          if (item && item[0]) text += item[0].transcript;
        }
        if (text) onTranscript?.(text);
      };
      recognition.onerror = (event) => {
        setListening(false);
        if (event.error === "not-allowed" || event.error === "service-not-allowed") {
          toast("麦克风未授权，请改用手动输入。", "warning");
        } else {
          toast("语音识别未成功，请改用手动输入。", "warning");
        }
      };
      recognition.onend = () => setListening(false);
      recognitionRef.current = recognition;
      recognition.start();
      setListening(true);
    } catch {
      setListening(false);
      toast("语音识别启动失败，请改用手动输入。", "warning");
    }
  }, [listening, onTranscript, supportInput, toast]);

  return (
    <div
      className={[
        "card card-pad space-y-3",
        sticky ? "sticky top-2 z-20 shadow-card" : "",
        className,
      ].join(" ")}
    >
      <div className="flex flex-wrap items-center gap-3">
        <BigButton
          variant={speaking ? "secondary" : "primary"}
          size="lg"
          onClick={handleSpeak}
          disabled={!supportSpeak}
        >
          {speaking ? "再读一遍" : "朗读"}
        </BigButton>
        <BigButton variant="ghost" onClick={handleStop} disabled={!supportSpeak || !speaking}>
          停止
        </BigButton>

        {allowInput ? (
          <BigButton
            variant={listening ? "warning" : "secondary"}
            size="lg"
            onClick={startRecognition}
            disabled={!supportInput}
          >
            {listening ? "停止说话…" : "语音输入"}
          </BigButton>
        ) : null}

        <BigButton
          variant="ghost"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
        >
          {expanded ? "收起设置" : "语速与人声"}
        </BigButton>
      </div>

      {expanded ? (
        <div className="space-y-3 border-t border-slate-200 pt-3">
          {/* 语速：用大按钮而非精细拖拽 */}
          <div className="flex flex-wrap items-center gap-3">
            <span className="text-elder text-ink-soft">语速</span>
            <BigButton
              variant="secondary"
              onClick={() => nudgeRate(-STEP)}
              disabled={prefs.rate <= RATE_MIN}
            >
              慢一点
            </BigButton>
            <span className="min-w-[72px] text-center text-elder-lg font-semibold text-ink">
              {prefs.rate.toFixed(1)} 倍
            </span>
            <BigButton
              variant="secondary"
              onClick={() => nudgeRate(STEP)}
              disabled={prefs.rate >= RATE_MAX}
            >
              快一点
            </BigButton>
          </div>

          {/* 人声：浏览器只给一个中文音色时没必要让老人选 */}
          {voices.length > 1 ? (
            <div className="space-y-2">
              <p className="text-elder text-ink-soft">换个人声</p>
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  aria-pressed={prefs.voiceName === ""}
                  onClick={() => setVoiceName("")}
                  className={[
                    "min-h-btn rounded-xl border-2 px-4 text-elder",
                    prefs.voiceName === ""
                      ? "border-medical-700 bg-medical-50 font-semibold text-medical-900"
                      : "border-slate-300 bg-white text-ink",
                  ].join(" ")}
                >
                  系统默认
                </button>
                {voices.map((voice) => {
                  const active = prefs.voiceName === voice.name;
                  return (
                    <button
                      key={voice.name}
                      type="button"
                      aria-pressed={active}
                      title={voice.name}
                      onClick={() => setVoiceName(voice.name)}
                      className={[
                        "min-h-btn rounded-xl border-2 px-4 text-elder",
                        active
                          ? "border-medical-700 bg-medical-50 font-semibold text-medical-900"
                          : "border-slate-300 bg-white text-ink",
                      ].join(" ")}
                    >
                      {shortVoiceLabel(voice.name)}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="text-elder text-ink-mute">
              {voices.length === 1
                ? "这台设备只有一种中文声音可用。"
                : "这台设备暂时读不出中文，可以改用语音输入或请工作人员帮忙。"}
            </p>
          )}

          <label className="flex min-h-btn items-center gap-3 text-elder text-ink">
            <input
              type="checkbox"
              className="h-6 w-6"
              checked={prefs.autoSpeak}
              onChange={(event) => setAutoSpeak(event.target.checked)}
            />
            每道题自动朗读
          </label>
        </div>
      ) : null}

      {!supportSpeak ? (
        <p className="text-elder text-ink-mute">当前浏览器不支持语音播报，请阅读屏幕文字。</p>
      ) : null}
      {allowInput && !supportInput ? (
        <p className="text-elder text-ink-mute">
          当前浏览器不支持语音输入，请使用输入框手动填写。
        </p>
      ) : null}
    </div>
  );
}
