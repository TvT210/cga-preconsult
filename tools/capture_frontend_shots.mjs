/**
 * 前端界面截图脚本（开发期自检用）。
 * 用无头 Chrome + CDP 打开页面，注入真实后端登录得到的 token，抓取水合后的页面截图。
 * 运行：node tools/capture_frontend_shots.mjs [前端地址] [后端 API 前缀]
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.argv[2] ?? "http://127.0.0.1:3000";
const API_BASE = process.argv[3] ?? "http://127.0.0.1:8000/api/v1";
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, "..", ".qa", "frontend", "shots");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9334;
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

const SHOTS = [
  { account: "elder", label: "elder", routes: [["/elder", "01-老人端首页"], ["/elder/scale/B.1", "02-适老化量表采集"], ["/elder/report", "03-报告与就医提醒"]] },
  { account: "nurse", label: "staff", routes: [["/staff", "04-医护端评估任务"], ["/staff/patients/1", "05-患者档案与匹配结果"], ["/staff/config", "06-阈值与量表配置"]] },
];

async function main() {
  await waitForChrome();
  const created = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/new?${encodeURIComponent("about:blank")}`, { method: "PUT" });
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
  await send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `${BASE}/login` });
  await sleep(2500);

  for (const group of SHOTS) {
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: group.account, password: `${group.account}12345` }),
    });
    const payload = await res.json();
    const token = payload?.data?.token ?? "";
    const user = payload?.data?.user ?? null;
    console.log(`[${group.label}] 登录 HTTP ${res.status}`);
    if (!token) continue;
    await evaluate(
      `localStorage.setItem('wfdn_token', ${JSON.stringify(token)});` +
        `localStorage.setItem('wfdn_user', ${JSON.stringify(JSON.stringify(user))});` +
        `true;`,
    );
    for (const [route, name] of group.routes) {
      await send("Page.navigate", { url: `${BASE}${route}` });
      await sleep(3200);
      const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const file = join(OUT_DIR, `${name}.png`);
      writeFileSync(file, Buffer.from(shot.data, "base64"));
      console.log(`  截图 ${file}`);
    }
  }
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
  await sleep(1000);
  try {
    rmSync(PROFILE, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
}
