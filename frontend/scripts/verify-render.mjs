/**
 * 前端渲染验证脚本（仅用于开发期自检，不属于前端应用源码）。
 * 用无头 Chrome + CDP 打开各页面，注入模拟登录态，抓取水合后的真实页面文本，
 * 确认后端不可用时页面展示的是友好错误态而不是白屏。
 *
 * 运行：node scripts/verify-render.mjs [baseUrl]
 */
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const BASE = process.argv[2] ?? "http://127.0.0.1:3111";
const API_BASE = process.argv[3] ?? "http://127.0.0.1:8000/api/v1";
const HERE = dirname(fileURLToPath(import.meta.url));
// 验证产物写入仓库统一的 .qa/frontend 目录（scripts -> frontend -> 仓库根）
const OUT_DIR = join(HERE, "..", "..", ".qa", "frontend");
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const DEBUG_PORT = 9333;
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

  // 先打开同源页面，才能写入 localStorage
  await send("Page.navigate", { url: `${BASE}/login` });
  await sleep(2500);

  const cases = [
    {
      account: "elder",
      label: "elder",
      routes: ["/elder", "/elder/scale/B.1", "/elder/chat", "/elder/report"],
    },
    {
      account: "nurse",
      label: "staff",
      routes: [
        "/staff",
        "/staff/patients",
        "/staff/patients/1",
        "/staff/review/1",
        "/staff/quality",
        "/staff/config",
      ],
    },
  ];

  const report = [];

  for (const group of cases) {
    // 使用真实后端登录取得的 token，保证验证覆盖真实鉴权链路
    let token = "";
    let user = null;
    try {
      const res = await fetch(`${API_BASE}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: group.account,
          password: `${group.account}12345`,
        }),
      });
      const payload = await res.json();
      token = payload?.data?.token ?? "";
      user = payload?.data?.user ?? null;
      console.log(
        `  [${group.label}] 后端登录 HTTP ${res.status}，token 长度 ${token.length}`,
      );
    } catch (error) {
      console.log(`  [${group.label}] 后端登录失败：${error.message}`);
    }
    if (!token) {
      token = "qa-token";
      user = {
        id: `qa-${group.account}`,
        username: group.account,
        role: group.account === "elder" ? "elder" : "staff",
        full_name: "模拟账号",
        patient_id: 1,
      };
    }
    await evaluate(
      `localStorage.setItem('wfdn_token', ${JSON.stringify(token)});` +
        `localStorage.setItem('wfdn_user', ${JSON.stringify(JSON.stringify(user))});` +
        `true;`,
    );

    for (const route of group.routes) {
      await send("Page.navigate", { url: `${BASE}${route}` });
      await sleep(3000);
      const text = await evaluate("document.body.innerText");
      // 输入框的值不在 innerText 中，单独采集以核对表单回填
      const inputs = await evaluate(
        "JSON.stringify(Array.from(document.querySelectorAll('input,select,textarea')).map((el) => el.value).filter((v) => v !== '' && v !== undefined))",
      );
      const blank = !text || text.trim().length < 10;
      const friendly = /暂时无法|无法获取|正在核对|请稍后重试|错误/.test(text ?? "");
      const white = blank ? "白屏/空页" : "有内容";
      report.push({
        role: group.label,
        route,
        length: (text ?? "").length,
        state: white,
        friendlyErrorOrShell: friendly,
        inputs: inputs ?? "",
      });
      writeFileSync(
        join(OUT_DIR, `render_${group.label}_${route.replace(/\//g, "_")}.txt`),
        (text ?? "") +
          (inputs && inputs !== "[]" ? `\n\n[表单回填值] ${inputs}` : ""),
        "utf8",
      );
    }
  }

  const failed = report.filter((item) => item.state === "白屏/空页");

  // 登录页：后端不可用时点击快捷角色入口应给出友好错误提示，而不是无响应
  await send("Page.navigate", { url: `${BASE}/login` });
  await sleep(2500);
  const clicked = await evaluate(`
    const buttons = Array.from(document.querySelectorAll('button'));
    const target = buttons.find((b) => b.textContent && b.textContent.includes('老人'));
    if (target) { target.click(); true; } else { false; }
  `);
  await sleep(3000);
  const loginText = (await evaluate("document.body.innerText")) ?? "";
  const loginFriendly = /网络连接失败|登录失败|请稍后重试|暂时无法/.test(loginText);
  writeFileSync(join(OUT_DIR, "render_login_submit.txt"), loginText, "utf8");
  report.push({
    role: "登录",
    route: "/login（提交快捷角色入口）",
    length: loginText.length,
    state: loginText.trim().length < 10 ? "白屏/空页" : "有内容",
    friendlyErrorOrShell: loginFriendly,
  });
  console.log(`  登录页提交后已点击按钮: ${clicked}，友好错误提示: ${loginFriendly}`);

  console.log("渲染验证结果：");
  report.forEach((item) => {
    console.log(
      `  [${item.role}] ${item.route.padEnd(28)} ${item.state}（${item.length} 字符）`,
    );
  });
  const notFriendly = report.filter((item) => !item.friendlyErrorOrShell);
  console.log(
    failed.length === 0
      ? "结论：所有页面均未白屏。"
      : `结论：${failed.length} 个页面疑似白屏。`,
  );
  if (notFriendly.length) {
    console.log(
      `注意：${notFriendly.length} 个页面未出现友好错误提示（可能为静态壳层）。`,
    );
  }
  process.exitCode = failed.length === 0 ? 0 : 1;
}

try {
  await main();
} catch (error) {
  console.error("验证脚本执行失败：", error);
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
