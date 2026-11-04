"use client";

import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { api, persistToken } from "@/lib/api";
import { homePathForRole, setStoredUser } from "@/lib/session";
import type { LoginResult } from "@/lib/types";
import { BigButton } from "@/components/BigButton";
import { ErrorState } from "@/components/ErrorState";

/** 演示账号快捷入口（契约 §1 预置账号） */
const QUICK_ACCOUNTS = [
  { label: "系统管理员", username: "admin", password: "admin12345" },
  { label: "医生", username: "doctor", password: "doctor12345" },
  { label: "护士／评估人员", username: "nurse", password: "nurse12345" },
  { label: "老人／家属", username: "elder", password: "elder12345" },
];

function LoginForm() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function doLogin(name: string, secret: string) {
    setSubmitting(true);
    setError("");
    try {
      const result = await api.post<LoginResult>("/auth/login", {
        username: name,
        password: secret,
      });
      persistToken(result.token);
      setStoredUser(result.user);
      const redirect = searchParams.get("redirect");
      router.replace(redirect ?? homePathForRole(result.user.role));
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "登录失败，请稍后重试。";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-4 py-10">
      <div className="card card-pad space-y-6">
        <header className="text-center">
          <h1 className="text-elder-2xl font-bold text-ink">
            老年人就医预问诊与老年综合评估系统
          </h1>
          <p className="mt-2 text-elder text-ink-soft">请登录后继续</p>
        </header>

        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            void doLogin(username.trim(), password);
          }}
        >
          <div>
            <label className="field-label" htmlFor="login-username">
              账号
            </label>
            <input
              id="login-username"
              className="field-input"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              placeholder="请输入账号"
            />
          </div>
          <div>
            <label className="field-label" htmlFor="login-password">
              密码
            </label>
            <input
              id="login-password"
              type="password"
              className="field-input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              placeholder="请输入密码"
            />
          </div>

          {error ? (
            <p
              className="rounded-xl border-2 border-red-300 bg-red-50 px-4 py-3 text-elder text-red-800"
              role="alert"
            >
              {error}
            </p>
          ) : null}

          <BigButton type="submit" size="lg" fullWidth loading={submitting}>
            登录
          </BigButton>
        </form>

        <section className="border-t border-slate-200 pt-5">
          <h2 className="text-elder font-semibold text-ink">快捷角色入口</h2>
          <p className="mt-1 text-elder text-ink-soft">
            演示环境预置账号，点击即可一键登录。
          </p>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {QUICK_ACCOUNTS.map((account) => (
              <BigButton
                key={account.username}
                variant="secondary"
                size="lg"
                disabled={submitting}
                onClick={() => void doLogin(account.username, account.password)}
              >
                {account.label}
                <span className="text-elder font-normal text-ink-soft">
                  （{account.username}）
                </span>
              </BigButton>
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto max-w-2xl px-4 py-16">
          <ErrorState message="页面加载中…" />
        </div>
      }
    >
      <LoginForm />
    </Suspense>
  );
}
