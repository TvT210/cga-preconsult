/**
 * 浏览器语音能力封装：语音播报（speechSynthesis）与语音输入（SpeechRecognition）。
 * 两者都做了优雅降级：不支持时调用方应隐藏按钮并提示手动输入。
 */

/* ----------------------------- 语音播报 ----------------------------- */

export interface SpeechOptions {
  rate?: number;
  lang?: string;
  /** 指定人声（`SpeechSynthesisVoice.name`）；找不到时回退浏览器默认 */
  voiceName?: string;
}

/** 可选人声（只保留与真人无关的元数据，便于在 UI 上直接列出来） */
export interface VoiceOption {
  name: string;
  lang: string;
  /** 是否为本机合成（离线可用，接口慢时更稳） */
  local: boolean;
}

/** 当前环境是否支持语音播报 */
export function canSpeak(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window;
}

/**
 * 从浏览器给出的人声里挑中文音色。
 *
 * 浏览器返回的是全量音色（Windows 上常见几十个，含英日德），老人端只应看到中文；
 * 同名去重、`zh-CN` 排前、`local` 排前——本机合成不依赖网络，门诊网差时更可靠。
 */
export function filterChineseVoices(
  voices: { name: string; lang: string; localService?: boolean }[],
): VoiceOption[] {
  const seen = new Set<string>();
  const picked: VoiceOption[] = [];
  voices.forEach((voice) => {
    const lang = (voice.lang || "").toLowerCase();
    if (!lang.startsWith("zh")) return;
    if (!voice.name || seen.has(voice.name)) return;
    seen.add(voice.name);
    picked.push({ name: voice.name, lang: voice.lang, local: voice.localService !== false });
  });
  return picked.sort((a, b) => {
    if (a.local !== b.local) return a.local ? -1 : 1;
    const aMainland = a.lang.toLowerCase().startsWith("zh-cn") ? 0 : 1;
    const bMainland = b.lang.toLowerCase().startsWith("zh-cn") ? 0 : 1;
    if (aMainland !== bMainland) return aMainland - bMainland;
    return a.name.localeCompare(b.name);
  });
}

/** 当前可用中文人声；浏览器可能异步加载音色，首次为空属正常 */
export function listVoices(): VoiceOption[] {
  if (!canSpeak()) return [];
  try {
    return filterChineseVoices(window.speechSynthesis.getVoices() ?? []);
  } catch {
    return [];
  }
}

/** 监听音色加载完成（Chrome 首次 `getVoices()` 返回空数组，需等该事件） */
export function onVoicesChanged(handler: () => void): () => void {
  if (!canSpeak()) return () => undefined;
  const synth = window.speechSynthesis;
  try {
    synth.addEventListener("voiceschanged", handler);
    return () => synth.removeEventListener("voiceschanged", handler);
  } catch {
    // 老浏览器只有 onvoiceschanged 属性赋值
    synth.onvoiceschanged = handler;
    return () => {
      synth.onvoiceschanged = null;
    };
  }
}

function resolveVoice(voiceName?: string) {
  if (!voiceName) return null;
  try {
    const voices = window.speechSynthesis.getVoices() ?? [];
    return voices.find((voice) => voice.name === voiceName) ?? null;
  } catch {
    return null;
  }
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
    const voice = resolveVoice(options.voiceName);
    // 存过的人声可能已从系统里被删掉：找不到就不设，跟随默认，不要静默换语言
    if (voice) utterance.voice = voice;
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
