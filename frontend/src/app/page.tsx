"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { LoadingState } from "@/components/ErrorState";
import { getStoredUser, getToken, homePathForRole } from "@/lib/session";

/** 入口页：按登录状态与角色跳转到对应首页 */
export default function HomePage() {
  const router = useRouter();

  useEffect(() => {
    const token = getToken();
    const user = getStoredUser();
    if (!token || !user) {
      router.replace("/login");
      return;
    }
    router.replace(homePathForRole(user.role));
  }, [router]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-16">
      <LoadingState label="正在进入系统…" />
    </div>
  );
}
