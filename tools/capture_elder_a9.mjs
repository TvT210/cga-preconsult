/**
 * A-9 老人端适老化改造 · 视觉自检截图。
 *
 * 与 capture_frontend_shots.mjs 同一套 CDP 做法，但额外覆盖：
 *   - 字号三档（点「特大」后重截，验证 CSS 变量确实生效）
 *   - 家属代答入口页
 *   - 量表页的吸顶语音条与吸底工具条
 *   - 打印媒体（Emulation.setEmulatedMedia=print）下的报告版式
 *   - 医护端「待处理协助请求」区块（先经 API 造一条真请求）
 *
 * 运行：node tools/capture_elder_a9.mjs [前端地址] [API 前缀]
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.argv[2] ?? "http://127.0.0.1:3000";
const API_BASE = process.argv[3] ?? "http://127.0.0.1:8000/api/v1";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", ".qa", "elder-a9");
// 本机可能只装了 Edge：两者都用同一套 CDP，按存在顺序取第一个
const BROWSER_CANDIDATES = [
  process.env.CGA_BROWSER ?? "",
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const CHROME = BROWSER_CANDIDATES.find((path) => path && existsSync(path));
if (!CHROME) {
  console.error("未找到 Chrome / Edge，可用 CGA_BROWSER 指定浏览器路径。");
  process.exit(1);
}
const DEBUG_PORT = 9336;
const PROFILE = join(OUT_DIR, "chrome-profile");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

mkdirSync(OUT_DIR, { recursive: true });

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-extensions",
    "--hide-scrollbars",
    "--window-size=1440,1000",
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${PROFILE}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

let ws;
let nextId = 1;
const pending = new Map();

function send(method, params = {}) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
}

async function waitForChrome() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      if (res.ok) return;
    } catch {
      /* 继续等待 */
    }
    await sleep(500);
  }
  throw new Error("无头 Chrome 未能在超时时间内就绪");
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return result?.result?.value;
}

async function shot(name) {
  const data = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  const file = join(OUT_DIR, `${name}.png`);
  writeFileSync(file, Buffer.from(data.data, "base64"));
  console.log(`  截图 ${file}`);
}

async function login(username) {
  const res = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: `${username}12345` }),
  });
  const payload = await res.json();
  const token = payload?.data?.token ?? "";
  const user = payload?.data?.user ?? null;
  console.log(`[${username}] 登录 HTTP ${res.status}`);
  if (!token) throw new Error(`登录失败：${username}`);
  await evaluate(
    `localStorage.setItem('wfdn_token', ${JSON.stringify(token)});` +
      `localStorage.setItem('wfdn_user', ${JSON.stringify(JSON.stringify(user))});` +
      `localStorage.removeItem('cga_elder_prefs_v1');` +
      "true;",
  );
  return { token, user };
}

async function main() {
  await waitForChrome();
  const created = await fetch(
    `http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent("about:blank")}`,
    { method: "PUT" },
  );
  const target = await created.json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", reject, { once: true });
  });
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
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1440,
    height: 1000,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await send("Page.navigate", { url: `${BASE}/login` });
  await sleep(2000);

  const elder = await login("elder");
  const elderToken = elder.token;

  // 造一份报告，打印版式才有内容可看（报告由医护端生成，走同一接口）
  const nurse = await login("nurse");
  const report = await fetch(`${API_BASE}/reports`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${nurse.token}` },
    body: JSON.stringify({ patient_id: elder.user?.patient_id, title: "老年综合评估报告（打印自检）" }),
  });
  console.log(`[nurse] 生成报告 HTTP ${report.status}`);
  await login("elder");

  // 造一条真实的协助请求，医护端才有东西可看
  const assist = await fetch(`${API_BASE}/elder/assistance`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${elderToken}` },
    body: JSON.stringify({ question_code: "B1-03", note: "这道题听不懂，想请人念一遍" }),
  });
  console.log(`[elder] 造协助请求 HTTP ${assist.status}`);

  // 1) 首页（标准字号）
  await send("Page.navigate", { url: `${BASE}/elder` });
  await sleep(3000);
  await shot("01-首页-标准字号");

  // 2) 切「特大」字号后重截（验证 data-elder-scale 生效且持久化）
  await evaluate(`
    (() => {
      const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === '特大');
      if (btn) btn.click();
      return btn ? 'clicked' : 'not-found';
    })()
  `);
  await sleep(800);
  const scale = await evaluate(
    `document.querySelector('.elder-theme')?.getAttribute('data-elder-scale') ?? 'missing'`,
  );
  const baseFont = await evaluate(
    `(() => { const el = document.querySelector('p.text-elder'); return el ? getComputedStyle(el).fontSize : 'no-text'; })()`,
  );
  console.log(`  字号档位=${scale} 正文=${baseFont}`);
  await shot("02-首页-特大字号");

  // 3) 家属代答入口
  await send("Page.navigate", { url: `${BASE}/elder/proxy` });
  await sleep(3000);
  await shot("03-家属代答入口");

  // 4) 量表页：吸顶语音条 + 吸底工具条 + 一步一屏
  await send("Page.navigate", { url: `${BASE}/elder/scale/B.1` });
  await sleep(3500);
  const hasDock = await evaluate(`Boolean(document.querySelector('.elder-dock'))`);
  const hasVoice = await evaluate(
    `Boolean([...document.querySelectorAll('div')].find((d) => d.className.includes('sticky')))`,
  );
  console.log(`  吸底条=${hasDock} 吸顶语音条=${hasVoice}`);
  await shot("04-量表页-一步一屏");

  // 5) 打印媒体下的报告页（纸质大字版）
  await send("Emulation.setEmulatedMedia", { media: "print" });
  await send("Page.navigate", { url: `${BASE}/elder/report` });
  await sleep(3200);
  const dockHidden = await evaluate(
    `(() => { const d = document.querySelector('.elder-dock'); return d ? getComputedStyle(d).display : 'missing'; })()`,
  );
  console.log(`  打印时吸底条 display=${dockHidden}`);
  await shot("05-报告页-打印版式");
  await send("Emulation.setEmulatedMedia", { media: "" });

  // 6) 医护端待处理协助请求
  await login("nurse");
  await send("Page.navigate", { url: `${BASE}/staff/patients` });
  await sleep(3200);
  await shot("06-医护端-协助请求");
}

try {
  await main();
} catch (error) {
  console.error("截图脚本执行失败：", error);
  process.exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {
    /* 忽略 */
  }
  chrome.kill();
}
