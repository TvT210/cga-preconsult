"""医护端与老人端界面截图（开发期自检）。

注意：医护端与老人端是**两套角色**，`RoleGuard` 会把越权访问重定向到本端首页。
因此每个页面必须用对应角色的令牌登录，否则截到的会是重定向后的页面
（例如用护士令牌访问 /elder 会被弹回 /staff，截图看起来"正常"实则拍错了页面）。
"""

from __future__ import annotations

import pathlib
import sys

BASE = "http://127.0.0.1:3000"
API_BASE = "http://127.0.0.1:8000/api/v1"
REPO = pathlib.Path(r"D:\ALLCODE\work\word2")
OUT = REPO / "output" / "staff-ui"
OUT.mkdir(parents=True, exist_ok=True)

# 预置账号（见 backend/app/... 初始化逻辑）
ACCOUNTS = {
    "staff": ("nurse", "nurse12345"),
    "elder": ("elder", "elder12345"),
}

# (输出名, 路由, 角色)
PAGES = [
    ("staff-tasks", "/staff", "staff"),
    ("staff-quality", "/staff/quality", "staff"),
    ("staff-knowledge", "/staff/knowledge", "staff"),
    ("staff-patient", "/staff/patients/11", "staff"),
    ("staff-review", "/staff/review/1", "staff"),
    ("elder-home", "/elder", "elder"),
    ("elder-report", "/elder/report", "elder"),
]


def main() -> int:
    # 可选参数：输出目录（相对仓库根或绝对路径）、页面名过滤子串
    out_dir = pathlib.Path(sys.argv[1]) if len(sys.argv) > 1 else OUT
    if not out_dir.is_absolute():
        out_dir = REPO / out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    name_filter = sys.argv[2] if len(sys.argv) > 2 else ""
    pages = [p for p in PAGES if name_filter in p[0]]

    script = r"""
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2];
const API_BASE = process.argv[3];
const OUT = process.argv[4];
const PAGES = JSON.parse(process.argv[5]);
const ACCOUNTS = JSON.parse(process.argv[6]);
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9336;
const PROFILE = join(OUT, "chrome-profile");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });

const chrome = spawn(CHROME, [
  // 注意：3D 图谱需要 WebGL，不能加 --disable-gpu；
  // headless 下用 SwiftShader 软件渲染，并显式允许（Chrome 120+ 默认禁用软件 WebGL）
  "--headless=new", "--no-first-run", "--hide-scrollbars",
  "--enable-unsafe-swiftshader", "--use-gl=angle", "--use-angle=swiftshader",
  "--window-size=1600,1100", `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${PROFILE}`, "about:blank",
], { stdio: "ignore" });

let ws, nextId = 1;
const pending = new Map();
function send(method, params = {}) {
  const id = nextId++;
  return new Promise((res, rej) => { pending.set(id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); });
}
async function waitChrome() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) return; } catch {}
    await sleep(500);
  }
  throw new Error("chrome 未就绪");
}
async function evaluate(expression) {
  const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  return r?.result?.value;
}

try {
  await waitChrome();
  const created = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: "PUT" });
  const target = await created.json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener("open", res, { once: true }); ws.addEventListener("error", rej, { once: true }); });
  ws.addEventListener("message", (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result); }
  });
  await send("Page.enable"); await send("Runtime.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1100, deviceScaleFactor: 1, mobile: false });

  // 逐角色登录，缓存令牌
  const sessions = {};
  for (const [role, creds] of Object.entries(ACCOUNTS)) {
    const r = await fetch(`${API_BASE}/auth/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: creds[0], password: creds[1] }),
    });
    const j = await r.json();
    sessions[role] = { token: j?.data?.token, user: j?.data?.user };
    if (!sessions[role].token) throw new Error(`${role} 登录失败`);
  }

  await send("Page.navigate", { url: `${BASE}/login` });
  await sleep(2500);

  for (const [name, route, role] of PAGES) {
    const s = sessions[role];
    // 切角色：先清空再写入对应令牌与用户信息
    await evaluate(`localStorage.removeItem('wfdn_token'); localStorage.removeItem('wfdn_user'); true;`);
    await evaluate(`localStorage.setItem('wfdn_token', ${JSON.stringify(s.token)}); localStorage.setItem('wfdn_user', ${JSON.stringify(JSON.stringify(s.user))}); true;`);
    await send("Page.navigate", { url: `${BASE}${route}` });
    await sleep(4500);
    const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(shot.data, "base64"));
    const info = await evaluate(`JSON.stringify({ href: location.href, text: (document.body.innerText || '').slice(0, 200) })`);
    writeFileSync(join(OUT, `${name}.txt`), info || "", "utf8");
    console.log(`[${name}] ${route} (${role}) -> ${info}`);
  }
} catch (e) {
  console.error("截图失败：", e);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(800);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
}
"""
    import json
    import subprocess

    script_path = pathlib.Path(r"C:\Users\Play\AppData\Local\Temp\capture_staff.mjs")
    script_path.write_text(script, encoding="utf-8")
    result = subprocess.run(
        [
            "node",
            str(script_path),
            BASE,
            API_BASE,
            str(out_dir),
            json.dumps(pages, ensure_ascii=False),
            json.dumps(ACCOUNTS, ensure_ascii=False),
        ],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
    )
    print(result.stdout)
    if result.stderr.strip():
        print(result.stderr[-800:])
    for name, _, _ in pages:
        path = out_dir / f"{name}.png"
        print(f"{'OK ' if path.exists() else '缺失'} {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
