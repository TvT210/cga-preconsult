"use client";

/**
 * 「用手机继续填写」——扫码把当前页面转到手机。
 *
 * 为什么需要它：老人端已经做了移动端适老化（字号三档、吸底操作条、一步一屏），
 * 但老人得先知道网址才能在手机上打开。让家属或工作人员扫一下码，是最省事的入口。
 *
 * 实现分工：
 * - 局域网 IP 由后端探测（浏览器拿不到可靠的网卡地址）；
 * - 页面地址由前端拼（前端才知道自己被访问的端口）；
 * - 二维码在浏览器里用 canvas 生成，不依赖外网服务。
 */

import { useCallback, useEffect, useState } from "react";
import { Check, Copy, Smartphone, WifiOff } from "lucide-react";

import { api } from "@/lib/api";
import { buildLanUrl, isLoopbackHost } from "@/lib/apiBase";
import { BigButton } from "./BigButton";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

interface LanInfo {
  hostname: string;
  primary: string | null;
  addresses: string[];
  has_lan: boolean;
}

export interface ScanToPhoneProps {
  /** 二维码指向的页面路径，默认老人端首页 */
  path?: string;
  /** 触发按钮文案 */
  label?: string;
  className?: string;
}

export function ScanToPhone({ path = "/elder", label = "用手机继续", className }: ScanToPhoneProps) {
  const [open, setOpen] = useState(false);
  // 是否已经在手机上（非回环地址访问）。null = 还不知道，此时不渲染按钮，
  // 避免手机端先闪一下「用手机填写」再消失。
  const [alreadyOnLan, setAlreadyOnLan] = useState<boolean | null>(null);

  const [info, setInfo] = useState<LanInfo | null>(null);
  const [selectedIp, setSelectedIp] = useState("");
  const [qrDataUrl, setQrDataUrl] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined") return;
    setAlreadyOnLan(!isLoopbackHost(window.location.hostname));
  }, []);

  const targetUrl = selectedIp
    ? buildLanUrl({
        ip: selectedIp,
        path,
        pagePort: typeof window !== "undefined" ? window.location.port : "",
        pageProtocol: typeof window !== "undefined" ? window.location.protocol : "http:",
      })
    : "";

  const loadLanInfo = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const data = await api.get<LanInfo>("/system/lan-addresses", undefined, { silent: true });
      setInfo(data);
      setSelectedIp(data.primary ?? data.addresses[0] ?? "");
      if (!data.has_lan) {
        setError("这台电脑没有可用的局域网地址，请检查是否连上 Wi-Fi 或有线网络。");
      }
    } catch {
      setError("读取本机网络地址失败，请稍后重试。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void loadLanInfo();
  }, [open, loadLanInfo]);

  // 二维码用动态 import：qrcode 的 Node 入口依赖文件系统，静态引入会在预渲染阶段报错
  useEffect(() => {
    if (!open || !targetUrl) {
      setQrDataUrl("");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const QRCode = (await import("qrcode")).default;
        const url = await QRCode.toDataURL(targetUrl, {
          width: 320,
          margin: 1,
          errorCorrectionLevel: "M",
        });
        if (!cancelled) setQrDataUrl(url);
      } catch {
        if (!cancelled) setError("二维码生成失败，可以直接复制下方地址在手机浏览器打开。");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, targetUrl]);

  const copyUrl = async () => {
    if (!targetUrl) return;
    try {
      await navigator.clipboard.writeText(targetUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      setError("复制失败，请长按选中地址手动复制。");
    }
  };

  // 只有确认「当前是回环访问（即在本机电脑上）」才显示入口
  if (alreadyOnLan !== false) return null;

  return (
    <>
      <BigButton
        type="button"
        variant="ghost"
        size="md"
        className={className}
        onClick={() => setOpen(true)}
      >
        <span className="inline-flex items-center gap-2">
          <Smartphone aria-hidden className="h-5 w-5" />
          {label}
        </span>
      </BigButton>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle className="text-lg">用手机继续填写</DialogTitle>
            <DialogDescription className="text-base leading-relaxed">
              让手机和这台电脑连<strong className="text-ink">同一个 Wi-Fi</strong>，然后用手机相机或微信扫下面的二维码。
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col items-center gap-3">
            {loading && <p className="py-10 text-base text-ink-soft">正在读取本机地址…</p>}

            {!loading && qrDataUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- dataURL 图片，无需 next/image 优化
              <img
                src={qrDataUrl}
                alt={`扫码打开 ${targetUrl}`}
                className="h-56 w-56 rounded-clin border border-clin-border bg-white p-2"
              />
            )}

            {!loading && !qrDataUrl && !error && (
              <p className="py-10 text-base text-ink-soft">正在生成二维码…</p>
            )}

            {!loading && error && (
              <div className="flex items-start gap-2 rounded-clin border border-amber-300 bg-amber-50 p-3 text-base text-amber-900">
                <WifiOff aria-hidden className="mt-0.5 h-5 w-5 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            {targetUrl && (
              <div className="w-full">
                <p className="text-sm text-ink-soft">手机浏览器打开这个地址也可以：</p>
                <div className="mt-1 flex items-center gap-2">
                  <code className="min-w-0 flex-1 truncate rounded border border-clin-border bg-clin-subtle px-2 py-1.5 text-sm">
                    {targetUrl}
                  </code>
                  <BigButton
                    type="button"
                    variant="secondary"
                    size="md"
                    onClick={() => void copyUrl()}
                    aria-label="复制地址"
                  >
                    <span className="inline-flex items-center gap-1">
                      {copied ? <Check aria-hidden className="h-4 w-4" /> : <Copy aria-hidden className="h-4 w-4" />}
                      {copied ? "已复制" : "复制"}
                    </span>
                  </BigButton>
                </div>
              </div>
            )}

            {info && info.addresses.length > 1 && (
              <details className="w-full text-sm text-ink-soft">
                <summary className="cursor-pointer select-none">扫不开？换一个网络地址</summary>
                <p className="mt-1">
                  电脑装了虚拟机或 VPN 时会有多个地址，选当前 Wi-Fi 对应的那个。
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {info.addresses.map((ip) => (
                    <button
                      key={ip}
                      type="button"
                      onClick={() => setSelectedIp(ip)}
                      className={
                        "rounded border px-2 py-1 font-mono text-xs " +
                        (ip === selectedIp
                          ? "border-medical-700 bg-medical-50 text-medical-800"
                          : "border-clin-border bg-white text-ink-soft hover:bg-clin-subtle")
                      }
                    >
                      {ip}
                    </button>
                  ))}
                </div>
              </details>
            )}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <BigButton type="button" variant="secondary" size="md">
                关闭
              </BigButton>
            </DialogClose>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
