"use client";

import { AppShell } from "@/components/AppShell";
import { ElderDock } from "@/components/ElderDock";
import { ElderPrefsProvider } from "@/components/ElderPrefs";
import { RoleGuard } from "@/components/RoleGuard";
import { useCurrentUser } from "@/lib/useCurrentUser";

const NAV = [
  { href: "/elder", label: "首页" },
  { href: "/elder/chat", label: "AI 对话" },
  { href: "/elder/report", label: "报告与提醒" },
  { href: "/elder/proxy", label: "家属代答" },
];

/**
 * 老人端布局：仅 elder 角色可访问。
 *
 * A-9：外层 `ElderPrefsProvider` 同时提供**字号三档作用域**（`div.elder-theme`）
 * 与偏好读写；`ElderDock` 是吸底常驻条（字号 / 呼叫工作人员），放在这里
 * 而不是各页面，才能做到「任何一页都够得着」。医护端走 StaffShell，不经过本文件。
 */
export default function ElderLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = useCurrentUser();

  return (
    <RoleGuard allow={["elder"]}>
      <ElderPrefsProvider>
        <AppShell
          title="老年健康服务平台"
          nav={NAV}
          user={user}
          homeHref="/elder"
        >
          {children}
        </AppShell>
        <ElderDock />
      </ElderPrefsProvider>
    </RoleGuard>
  );
}
