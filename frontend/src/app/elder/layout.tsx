"use client";

import { AppShell } from "@/components/AppShell";
import { RoleGuard } from "@/components/RoleGuard";
import { useCurrentUser } from "@/lib/useCurrentUser";

const NAV = [
  { href: "/elder", label: "首页" },
  { href: "/elder/chat", label: "AI 对话" },
  { href: "/elder/report", label: "报告与提醒" },
];

/** 老人端布局：仅 elder 角色可访问 */
export default function ElderLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = useCurrentUser();

  return (
    <RoleGuard allow={["elder"]}>
      <AppShell
        title="老年健康服务平台"
        nav={NAV}
        user={user}
        homeHref="/elder"
      >
        {children}
      </AppShell>
    </RoleGuard>
  );
}
