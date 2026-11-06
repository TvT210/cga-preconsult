/**
 * 采集老人端页面的 **DOM 结构签名**，用于「老人端视觉零变化」的硬校验。
 *
 * 为什么需要它：像素比对会受浏览器栅格化影响（不同构建产物的圆角抗锯齿
 * 可能有 ±20/255 的亚像素差异，肉眼不可辨但会让「严格 0 差异」判据失败）。
 * DOM 签名则是**结构级**证据：标签、class、内联样式、文本逐行比对，
 * 一致即说明老人端没有任何样式或结构改动。
 *
 * 用法：
 *   node tools/dump_dom_signature.mjs <输出目录> [后端地址] [前端地址]
 */
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const OUT = resolve(process.argv[2] || "output/dom-signature");
const API_BASE = process.argv[3] || "http://127.0.0.1:8000/api/v1";
const BASE = process.argv[4] || "http://127.0.0.1:3000";
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = Number(process.argv[5] || 9371);
const ROUTES = [
  ["/elder", "_elder"],
  ["/elder/report", "_elder_report"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

// 清理上一次的 profile（残留锁会导致 chrome 起不来）
const PROFILE = join(OUT, "chrome-profile");
try {
  rmSync(PROFILE, { recursive: true, force: true });
} catch {}

const chrome = spawn(CHROME, [
  "--headless=new", "--no-first-run", "--hide-scrollbars",
  "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
  "--window-size=1600,1100", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`, "about:blank",
], { stdio: ["ignore", "ignore", "pipe"] });
chrome.stderr.on("data", (buf) => {
  const text = String(buf).trim();
  if (text) console.error("[chrome]", text.slice(0, 300));
});

let ws, nextId = 1;
const pending = new Map();
function send(method, params = {}) {
  const id = nextId++;
  return new Promise((res, rej) => {
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function waitChrome() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error("chrome 未就绪");
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  return r?.result?.value;
}

/** DOM 结构签名：标签 + class + 内联样式 + 文本，逐行输出 */
const SIGNATURE = `(() => {
  const walk = (node, depth) => {
    if (node.nodeType === 3) {
      const t = (node.textContent || "").trim();
      return t ? "  ".repeat(depth) + "#text:" + t : "";
    }
    if (node.nodeType !== 1) return "";
    const cls = node.getAttribute("class") || "";
    const style = node.getAttribute("style") || "";
    let out = "  ".repeat(depth) + "<" + node.tagName.toLowerCase();
    if (cls) out += ' class="' + cls + '"';
    if (style) out += ' style="' + style + '"';
    out += ">";
    for (const child of node.childNodes) out += "\\n" + walk(child, depth + 1);
    return out;
  };
  return walk(document.body, 0);
})()`;

try {
  // 后端健康检查：后端不在时页面只会停在「正在核对登录信息…」，
  // 那样采到的 DOM 签名是加载页，会让比对失去意义。
  const health = await fetch(`${API_BASE}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "elder", password: "elder12345" }),
  });
  if (!health.ok) throw new Error(`后端登录失败 HTTP ${health.status}`);

  await waitChrome();
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
  const target = await created.json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result);
    }
  });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", {
    width: 1600,
    height: 1100,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const login = await (
    await fetch(`${API_BASE}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "elder", password: "elder12345" }),
    })
  ).json();
  await send("Page.navigate", { url: `${BASE}/login` });
  await sleep(2000);
  await evaluate(
    `localStorage.setItem('wfdn_token', ${JSON.stringify(login.data.token)});` +
      `localStorage.setItem('wfdn_user', ${JSON.stringify(JSON.stringify(login.data.user))}); true;`,
  );

  for (const [route, name] of ROUTES) {
    await send("Page.navigate", { url: `${BASE}${route}` });
    // 等页面真正渲染完：登录校验期间的「正在核对登录信息…」必须消失，
    // 否则采到的是加载页，比对毫无意义（之前踩过这个坑）。
    let ready = false;
    for (let i = 0; i < 40; i++) {
      await sleep(500);
      const loading = await evaluate(
        `(document.body.innerText || "").includes("正在核对登录信息")`,
      );
      if (loading === false) {
        ready = true;
        break;
      }
    }
    if (!ready) console.warn(`[警告] ${route} 在 20 秒内未渲染完成，可能采到加载页`);
    await sleep(800);
    const sig = await evaluate(SIGNATURE);
    writeFileSync(join(OUT, `${name}.signature.txt`), sig || "", "utf8");
    console.log(`[${route}] DOM 签名 ${(sig || "").length} 字符 -> ${name}.signature.txt`);
  }
} catch (e) {
  console.error("失败：", e);
  process.exitCode = 1;
} finally {
  try {
    ws?.close();
  } catch {}
  chrome.kill();
  await sleep(600);
  try {
    rmSync(join(OUT, "chrome-profile"), { recursive: true, force: true });
  } catch {}
  process.exit(process.exitCode || 0);
}
