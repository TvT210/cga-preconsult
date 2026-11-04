"""验证医护端「预问诊」页签为只读（且归属提示可见）。"""

from __future__ import annotations

import json
import pathlib
import subprocess
import sys

BASE = "http://127.0.0.1:3000"
API_BASE = "http://127.0.0.1:8000/api/v1"
OUT = pathlib.Path(r"D:\ALLCODE\work\word2\output\staff-ui")
OUT.mkdir(parents=True, exist_ok=True)

SCRIPT = r"""
import { spawn } from "node:child_process";
import { writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const BASE = process.argv[2];
const API_BASE = process.argv[3];
const OUT = process.argv[4];
const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const PORT = 9338;
const PROFILE = join(OUT, "chrome-profile-ro");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(CHROME, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--hide-scrollbars",
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

  const login = await (await fetch(`${API_BASE}/auth/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: "nurse", password: "nurse12345" }),
  })).json();
  const token = login?.data?.token;
  const user = login?.data?.user;

  await send("Page.navigate", { url: `${BASE}/login` });
  await sleep(2500);
  await evaluate(`localStorage.setItem('wfdn_token', ${JSON.stringify(token)}); localStorage.setItem('wfdn_user', ${JSON.stringify(JSON.stringify(user))}); true;`);

  await send("Page.navigate", { url: `${BASE}/staff/patients/11` });
  await sleep(4500);
  // 点击「预问诊」页签
  const clicked = await evaluate(`
    const btn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent && b.textContent.trim() === '预问诊');
    if (btn) { btn.click(); true; } else { false; }
  `);
  await sleep(2500);
  const text = (await evaluate("document.body.innerText")) || "";
  const inputs = await evaluate("document.querySelectorAll('input, textarea, select').length");
  const shot = await send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
  writeFileSync(join(OUT, "staff-preconsult-readonly.png"), Buffer.from(shot.data, "base64"));
  writeFileSync(join(OUT, "staff-preconsult-readonly.txt"), text, "utf8");
  console.log(JSON.stringify({ clicked, inputs, hasOwnership: text.includes("患者端"), hasSaveButton: /保存预问诊|保存内容/.test(text), length: text.length }));
} catch (e) {
  console.error("失败：", e);
} finally {
  try { ws?.close(); } catch {}
  chrome.kill();
  await sleep(800);
  try { rmSync(PROFILE, { recursive: true, force: true }); } catch {}
}
"""


def main() -> int:
    script_path = pathlib.Path(r"C:\Users\Play\AppData\Local\Temp\capture_ro.mjs")
    script_path.write_text(SCRIPT, encoding="utf-8")
    result = subprocess.run(
        ["node", str(script_path), BASE, API_BASE, str(OUT)],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=300,
    )
    print(result.stdout.strip())
    if result.stderr.strip():
        print(result.stderr[-600:])
    return 0


if __name__ == "__main__":
    sys.exit(main())
