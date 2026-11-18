/**
 * 老人端窄屏自检（A-9 验收：360px / 414px 无横向滚动）。
 *
 * 用 CDP 把视口压到手机宽度，逐页比较 `documentElement.scrollWidth` 与 `innerWidth`。
 * 超出即判失败——老人端一旦要横向拖动，基本等于不能用。
 *
 * 运行：node tools/check_elder_mobile.mjs [前端地址] [API 前缀]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.argv[2] ?? "http://127.0.0.1:3000";
const API_BASE = process.argv[3] ?? "http://127.0.0.1:8000/api/v1";
const HERE = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(HERE, "..", ".qa", "elder-a9", "chrome-profile-mobile");
const DEBUG_PORT = 9338;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const BROWSERS = [
  process.env.CGA_BROWSER ?? "",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const BROWSER = BROWSERS.find((path) => path && existsSync(path));
if (!BROWSER) {
  console.error("未找到 Chrome / Edge，可用 CGA_BROWSER 指定浏览器路径。");
  process.exit(1);
}

mkdirSync(PROFILE, { recursive: true });
const chrome = spawn(
  BROWSER,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--hide-scrollbars",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

let ws;
let nextId = 1;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return result?.result?.value;
};

const PAGES = [
  ["/elder", "首页"],
  ["/elder/proxy", "家属代答"],
  ["/elder/scale/B.1", "量表作答"],
  ["/elder/report", "报告与提醒"],
];
const WIDTHS = [360, 414];
const SCALES = ["standard", "xlarge"];

async function waitForChrome() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return;
    } catch {
      /* 继续等 */
    }
    await sleep(500);
  }
  throw new Error("无头浏览器未就绪");
}

async function main() {
  await waitForChrome();
  const created = await fetch(
    `http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent("about:blank")}`,
    { method: "PUT" },
  );
  const target = await created.json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener("open", resolve, { once: true }));
  ws.addEventListener("message", (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  await send("Page.enable");
  await send("Runtime.enable");

  const login = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "elder", password: "elder12345" }),
  });
  const payload = await login.json();
  const token = payload?.data?.token ?? "";
  const user = payload?.data?.user ?? null;

  await send("Emulation.setDeviceMetricsOverride", {
    width: 360,
    height: 780,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await send("Page.navigate", { url: `${BASE}/login` });
  await sleep(1500);
  await evaluate(
    `localStorage.setItem('wfdn_token', ${JSON.stringify(token)});` +
      `localStorage.setItem('wfdn_user', ${JSON.stringify(JSON.stringify(user))});true;`,
  );

  let failures = 0;
  for (const scale of SCALES) {
    for (const width of WIDTHS) {
      await send("Emulation.setDeviceMetricsOverride", {
        width,
        height: 780,
        deviceScaleFactor: 1,
        mobile: true,
      });
      for (const [route, label] of PAGES) {
        await send("Page.navigate", { url: `${BASE}${route}` });
        await sleep(2200);
        await evaluate(
          `localStorage.setItem('cga_elder_prefs_v1', ${JSON.stringify(
            JSON.stringify({ fontScale: scale, rate: 0.9, voiceName: "", autoSpeak: false }),
          )});true;`,
        );
        await send("Page.reload");
        await sleep(2600);
        const metrics = await evaluate(`(() => {
          const dock = document.querySelector('.elder-dock');
          const main = document.querySelector('main');
          return {
            doc: document.documentElement.scrollWidth,
            inner: window.innerWidth,
            scale: document.querySelector('.elder-theme')?.getAttribute('data-elder-scale') ?? 'missing',
            dock: dock ? dock.offsetHeight : 0,
            pad: main ? parseFloat(getComputedStyle(main).paddingBottom) : 0,
          };
        })()`);
        // 与**模拟宽度**比较，不用 innerWidth：手机模式下内容超宽时浏览器会把
        // 视口拉大（shrink-to-fit），innerWidth 也跟着变大，用它比会漏报溢出。
        const overflow = (metrics?.doc ?? 0) - width;
        // 吸底条不得压住正文：main 的留白必须不小于吸底条实测高度
        const covered = (metrics?.dock ?? 0) > (metrics?.pad ?? 0) + 1;
        const ok = overflow <= 1 && metrics?.scale === scale && !covered;
        if (!ok) failures += 1;
        console.log(
          `${ok ? "PASS" : "FAIL"}  ${width}px ${scale.padEnd(8)} ${label}  scrollWidth=${metrics?.doc} 档位=${metrics?.scale} 吸底条=${metrics?.dock}px 留白=${metrics?.pad}px`,
        );
      }
    }
  }
  console.log(failures ? `\n${failures} 项不通过` : "\n全部页面在 360/414px 下无横向滚动");
  if (failures) process.exitCode = 1;
}

try {
  await main();
} catch (error) {
  console.error("窄屏自检失败：", error);
  process.exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {
    /* 忽略 */
  }
  chrome.kill();
}
