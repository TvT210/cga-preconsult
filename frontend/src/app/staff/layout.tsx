"use client";

import { AppShell } from "@/components/AppShell";
import { RoleGuard } from "@/components/RoleGuard";
import { useCurrentUser } from "@/lib/useCurrentUser";

const NAV = [
  { href: "/staff", label: "评估任务" },
  { href: "/staff/patients", label: "患者管理" },
  { href: "/staff/quality", label: "质控看板" },
  { href: "/staff/config", label: "配置与质控" },
];

/** 医护端布局：staff / doctor / admin 角色可访问 */
export default function StaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = useCurrentUser();

  return (
    <RoleGuard allow={["staff", "doctor", "admin"]}>
      <AppShell
        title="老年综合评估工作台"
        nav={NAV}
        user={user}
        homeHref="/staff"
      >
        {children}
      </AppShell>
    </RoleGuard>
  );
}
