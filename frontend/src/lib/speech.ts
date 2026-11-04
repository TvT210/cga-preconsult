/**
 * 浏览器语音能力封装：语音播报（speechSynthesis）与语音输入（SpeechRecognition）。
 * 两者都做了优雅降级：不支持时调用方应隐藏按钮并提示手动输入。
 */

/* ----------------------------- 语音播报 ----------------------------- */

export interface SpeechOptions {
  rate?: number;
  lang?: string;
}

/** 当前环境是否支持语音播报 */
export function canSpeak(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/** 朗读文本；返回是否成功发起朗读 */
export function speakText(text: string, options: SpeechOptions = {}): boolean {
  if (!canSpeak() || !text) return false;
  try {
    const synth = window.speechSynthesis;
    synth.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = options.lang ?? "zh-CN";
    utterance.rate = options.rate ?? 0.9;
    utterance.pitch = 1;
    synth.speak(utterance);
    return true;
  } catch {
    return false;
  }
}

/** 停止朗读 */
export function stopSpeaking(): void {
  if (!canSpeak()) return;
  try {
    window.speechSynthesis.cancel();
  } catch {
    /* 忽略 */
  }
}

/* ----------------------------- 语音输入 ----------------------------- */

export interface SpeechRecognitionAlternative {
  transcript: string;
}

export interface SpeechRecognitionResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternative;
}

export interface SpeechRecognitionEvent {
  results: {
    length: number;
    [index: number]: SpeechRecognitionResult;
  };
}

export interface SpeechRecognitionErrorEvent {
  error: string;
}

export interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: SpeechRecognitionEvent) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}

export type SpeechRecognitionConstructor = new () => SpeechRecognitionInstance;

/** 获取语音识别构造器，不支持时返回 null */
export function getSpeechRecognition(): SpeechRecognitionConstructor | null {
  if (typeof window === "undefined") return null;
  const scope = window as unknown as {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

/** 当前环境是否支持语音输入 */
export function canRecognizeSpeech(): boolean {
  return getSpeechRecognition() !== null;
}
