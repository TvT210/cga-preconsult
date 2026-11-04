"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  canRecognizeSpeech,
  canSpeak,
  getSpeechRecognition,
  speakText,
  stopSpeaking,
  type SpeechRecognitionInstance,
} from "@/lib/speech";
import { BigButton } from "./BigButton";
import { useToast } from "./Toast";

const MIN_RATE = 0.6;
const MAX_RATE = 1.2;
const STEP = 0.1;

export interface VoiceBarProps {
  /** 需要朗读的内容（当前题目与选项） */
  speechText: string;
  /** 语速，范围 0.6~1.2 */
  rate: number;
  onRateChange: (rate: number) => void;
  /** 语音输入识别结果 */
  onTranscript?: (text: string) => void;
  /** 是否允许语音输入（部分页面无输入框时关闭） */
  allowInput?: boolean;
  className?: string;
}

/**
 * 语音条：朗读当前题目（可重复播放、语速可调）+ 语音输入。
 * 浏览器不支持时优雅降级：隐藏对应按钮并提示手动输入。
 */
export function VoiceBar({
  speechText,
  rate,
  onRateChange,
  onTranscript,
  allowInput = true,
  className = "",
}: VoiceBarProps) {
  const toast = useToast();
  const [speaking, setSpeaking] = useState(false);
  const [listening, setListening] = useState(false);
  const recognitionRef = useRef<SpeechRecognitionInstance | null>(null);
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

  const handleSpeak = useCallback(() => {
    if (!supportSpeak) {
      toast("当前浏览器不支持语音播报，请阅读屏幕文字。", "warning");
      return;
    }
    const ok = speakText(speechText, { rate });
    if (ok) {
      setSpeaking(true);
      window.setTimeout(() => setSpeaking(false), Math.max(1500, speechText.length * 260));
    } else {
      toast("语音播报启动失败，请阅读屏幕文字。", "warning");
    }
  }, [speechText, rate, supportSpeak, toast]);

  const handleStop = useCallback(() => {
    stopSpeaking();
    setSpeaking(false);
  }, []);

  const adjustRate = useCallback(
    (delta: number) => {
      const next = Math.min(MAX_RATE, Math.max(MIN_RATE, Number((rate + delta).toFixed(1))));
      onRateChange(next);
    },
    [rate, onRateChange],
  );

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
    <div className={`card card-pad space-y-4 ${className}`}>
      <div className="flex flex-wrap items-center gap-3">
        <BigButton
          variant={speaking ? "secondary" : "primary"}
          size="lg"
          onClick={handleSpeak}
          disabled={!supportSpeak}
        >
          {speaking ? "正在朗读…" : "朗读题目"}
        </BigButton>
        <BigButton variant="ghost" onClick={handleStop} disabled={!supportSpeak || !speaking}>
          停止朗读
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
      </div>

      {/* 语速调节：用大按钮而非精细拖拽 */}
      <div className="flex flex-wrap items-center gap-3">
        <span className="text-elder text-ink-soft">语速</span>
        <BigButton variant="secondary" onClick={() => adjustRate(-STEP)} disabled={rate <= MIN_RATE}>
          慢一点
        </BigButton>
        <span className="min-w-[72px] text-center text-elder-lg font-semibold text-ink">
          {rate.toFixed(1)} 倍
        </span>
        <BigButton variant="secondary" onClick={() => adjustRate(STEP)} disabled={rate >= MAX_RATE}>
          快一点
        </BigButton>
      </div>

      {!supportSpeak ? (
        <p className="text-elder text-ink-mute">当前浏览器不支持语音播报，请阅读屏幕文字。</p>
      ) : null}
      {allowInput && !supportInput ? (
        <p className="text-elder text-ink-mute">
          当前浏览器不支持语音输入，请使用下方输入框手动填写。
        </p>
      ) : null}
    </div>
  );
}
