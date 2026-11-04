"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter } from "next/navigation";
import { ApiError, api } from "@/lib/api";
import {
  clearSession,
  getStoredUser,
  getToken,
  homePathForRole,
} from "@/lib/session";
import type { Role, User } from "@/lib/types";
import { LoadingState } from "./ErrorState";

export interface RoleGuardProps {
  /** 允许访问的角色 */
  allow: Role[];
  children: React.ReactNode;
}

/**
 * 角色路由守卫：未登录跳转登录页；角色不符跳转到其所属首页。
 * 老人仅访问本人数据由后端强制（契约 §10），前端只做角色与入口收敛。
 */
export function RoleGuard({ allow, children }: RoleGuardProps) {
  const router = useRouter();
  const pathname = usePathname();
  const allowKey = allow.join(",");
  const [user, setUser] = useState<User | null>(null);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const allowed = allowKey.split(",").filter(Boolean) as Role[];

    async function bootstrap() {
      const token = getToken();
      const stored = getStoredUser();
      if (!token || !stored) {
        clearSession();
        router.replace(`/login?redirect=${encodeURIComponent(pathname)}`);
        return;
      }
      if (!allowed.includes(stored.role)) {
        router.replace(homePathForRole(stored.role));
        return;
      }
      setUser(stored);
      try {
        // 校验登录态并刷新用户信息（401 由 api 层统一处理）
        const me = await api.get<User>("/auth/me", undefined);
        if (!cancelled && me) setUser(me);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          return; // api 层已处理跳转
        }
        // 网络异常时保留本地登录态，避免后端未启动就把用户踢出
      } finally {
        if (!cancelled) setChecking(false);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [allowKey, pathname, router]);

  if (checking) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-10">
        <LoadingState label="正在核对登录信息…" />
      </div>
    );
  }

  if (!user) return null;
  return <>{children}</>;
}
