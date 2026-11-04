"use client";

import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import { getStoredUser } from "./session";
import type { User } from "./types";

/**
 * 当前登录用户。优先用 /auth/me 校验，接口不可用时退回本地缓存，
 * 保证后端未启动时页面仍能给出可读内容而不是白屏。
 */
export function useCurrentUser() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(async () => {
    try {
      const me = await api.get<User>("/auth/me");
      setUser(me);
    } catch {
      setUser(getStoredUser());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { user, loading, reload };
}
