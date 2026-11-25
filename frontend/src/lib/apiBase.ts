/**
 * 后端接口地址推导。
 *
 * 为什么不能写死 127.0.0.1
 * ----------------------
 * 老人用手机扫码打开页面时，页面来自 `http://192.168.x.x:3000`，但 API 若仍指向
 * `http://127.0.0.1:8000`，手机请求的是**它自己**的回环地址，必然连不上。
 *
 * 推导规则（从高到低）
 * 1. 显式配置了 `NEXT_PUBLIC_API_BASE`：
 *    - 配置的是回环地址（127.0.0.1 / localhost），而页面是从局域网地址打开的
 *      → 把 host 换成当前访问的 host，端口与路径不动（手机扫码场景）；
 *    - 其余情况原样使用（生产环境前后端分域名部署时不改写）。
 * 2. 未配置：跟随页面 host + 默认 8000 端口。
 * 3. 两者都没有（极少见）：退回回环地址。
 *
 * 抽成纯函数是为了能单测——这段逻辑一旦写错，表现是「手机打开后一片空白」，
 * 排查成本很高。
 */

export const DEFAULT_API_PORT = 8000;
export const DEFAULT_API_PATH = "/api/v1";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0"]);

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export interface ResolveApiBaseOptions {
  /** `process.env.NEXT_PUBLIC_API_BASE` */
  explicit?: string;
  /** `window.location.hostname`；非浏览器环境留空 */
  pageHost?: string;
  /** `window.location.protocol`，默认 `http:` */
  protocol?: string;
  /** 覆盖默认端口，便于测试 */
  apiPort?: number;
}

export function resolveApiBase(options: ResolveApiBaseOptions = {}): string {
  const explicit = (options.explicit ?? "").trim();
  const pageHost = (options.pageHost ?? "").trim();
  const protocol = (options.protocol ?? "http:").trim() || "http:";
  const apiPort = options.apiPort ?? DEFAULT_API_PORT;

  if (explicit) {
    try {
      const url = new URL(explicit);
      if (isLoopbackHost(url.hostname) && pageHost && !isLoopbackHost(pageHost)) {
        url.hostname = pageHost;
      }
      return stripTrailingSlash(url.toString());
    } catch {
      // 配置值不是完整 URL（例如只写了主机名），原样返回交给上层报错
      return stripTrailingSlash(explicit);
    }
  }

  if (pageHost) {
    return `${protocol}//${pageHost}:${apiPort}${DEFAULT_API_PATH}`;
  }

  return `http://127.0.0.1:${apiPort}${DEFAULT_API_PATH}`;
}

/**
 * 构造「手机可访问」的页面地址：把当前页面的 host 换成局域网 IP，端口与路径保持。
 *
 * 用于生成二维码。当前页面若已经是局域网地址，则原样返回（避免再拼一次）。
 */
export function buildLanUrl(options: {
  ip: string;
  path: string;
  pagePort?: string;
  pageProtocol?: string;
  pageHost?: string;
}): string {
  const ip = (options.ip ?? "").trim();
  if (!ip) return "";
  const protocol = (options.pageProtocol ?? "http:") || "http:";
  const path = options.path.startsWith("/") ? options.path : `/${options.path}`;
  const port = (options.pagePort ?? "").trim();
  const suffix = port ? `:${port}` : "";
  return `${protocol}//${ip}${suffix}${path}`;
}
