"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import {
  DEFAULT_ELDER_PREFS,
  FONT_SCALES,
  nextFontScale,
  normalizeRate,
  readElderPrefs,
  stepRate,
  writeElderPrefs,
  type ElderPrefs,
  type FontScale,
} from "@/lib/elderPrefs";

interface ElderPrefsValue {
  prefs: ElderPrefs;
  /** 是否已从本地读完；未读完前不做自动朗读等副作用 */
  ready: boolean;
  setFontScale: (scale: FontScale) => void;
  cycleFontScale: () => void;
  setRate: (rate: number) => void;
  nudgeRate: (delta: number) => void;
  setVoiceName: (name: string) => void;
  setAutoSpeak: (on: boolean) => void;
}

const ElderPrefsContext = createContext<ElderPrefsValue | null>(null);

/**
 * 老人端显示偏好容器（A-9）。
 *
 * 同时承担**主题作用域**：外层 `div.elder-theme` 上的 `data-elder-scale` 决定
 * `globals.css` 里 `--e-fs-*` 取哪一档，因此页面组件不需要感知字号。
 * 必须包在老人端 layout 内，医护端不经过这里。
 */
export function ElderPrefsProvider({ children }: { children: React.ReactNode }) {
  // 首屏用默认值渲染，挂载后再读本地：避免服务端与客户端首帧不一致导致水合报错
  const [prefs, setPrefs] = useState<ElderPrefs>(DEFAULT_ELDER_PREFS);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setPrefs(readElderPrefs());
    setReady(true);
  }, []);

  const persist = useCallback((next: ElderPrefs) => {
    setPrefs(next);
    writeElderPrefs(next);
  }, []);

  const value = useMemo<ElderPrefsValue>(
    () => ({
      prefs,
      ready,
      setFontScale: (scale) => persist({ ...prefs, fontScale: scale }),
      cycleFontScale: () => persist({ ...prefs, fontScale: nextFontScale(prefs.fontScale) }),
      setRate: (rate) => persist({ ...prefs, rate: normalizeRate(rate) }),
      nudgeRate: (delta) => persist({ ...prefs, rate: stepRate(prefs.rate, delta) }),
      setVoiceName: (name) => persist({ ...prefs, voiceName: name }),
      setAutoSpeak: (on) => persist({ ...prefs, autoSpeak: on }),
    }),
    [prefs, ready, persist],
  );

  return (
    <ElderPrefsContext.Provider value={value}>
      <div className="elder-theme" data-elder-scale={prefs.fontScale}>
        {children}
      </div>
    </ElderPrefsContext.Provider>
  );
}

export function useElderPrefs(): ElderPrefsValue {
  const ctx = useContext(ElderPrefsContext);
  if (!ctx) {
    throw new Error("useElderPrefs 必须在 ElderPrefsProvider 内使用");
  }
  return ctx;
}

/** 字号三档大按钮组：独立成组件，工具条与设置面板共用 */
export function FontScaleSwitch({ className = "" }: { className?: string }) {
  const { prefs, setFontScale } = useElderPrefs();
  return (
    <div className={`flex flex-wrap items-center gap-2 ${className}`}>
      <span className="text-elder text-ink-soft">字号</span>
      <div role="group" aria-label="选择字号" className="flex flex-wrap gap-2">
        {FONT_SCALES.map((item) => {
          const active = prefs.fontScale === item.value;
          return (
            <button
              key={item.value}
              type="button"
              aria-pressed={active}
              onClick={() => setFontScale(item.value)}
              className={[
                "min-h-btn rounded-xl border-2 px-4 text-elder font-semibold transition-colors",
                active
                  ? "border-medical-700 bg-medical-700 text-white"
                  : "border-slate-300 bg-white text-ink hover:border-medical-400",
              ].join(" ")}
            >
              {item.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
