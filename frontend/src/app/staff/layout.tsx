"use client";

import { RoleGuard } from "@/components/RoleGuard";
import { useCurrentUser } from "@/lib/useCurrentUser";
import { StaffShell } from "./StaffShell";

/**
 * 医护端布局：staff / doctor / admin 角色可访问。
 *
 * 根元素带 `theme-clinical` class，激活 `globals.css` 中的
 * `.theme-clinical` 作用域 —— 该作用域只改写医护端的字号/圆角/阴影/
 * 配色 token，**老人端作用域（默认）完全不受影响**。
 */
export default function StaffLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user } = useCurrentUser();

  return (
    <RoleGuard allow={["staff", "doctor", "admin"]}>
      <div className="theme-clinical">
        <StaffShell user={user}>{children}</StaffShell>
      </div>
    </RoleGuard>
  );
}
