"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  Brain,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  Settings,
  Users,
} from "lucide-react";
import { clearSession, roleLabel } from "@/lib/session";
import type { User } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * 医护端外壳（**线 B**：简洁风格）。
 *
 * 依据《医护端视觉规范》§4 布局骨架：
 * - 侧边栏 216px、白底、右侧 1px 竖线、项高 40px、图标 + 文字；
 * - 当前项：左侧 2px teal 竖条 + accentSoft 底色，**不用**彩色实心块；
 * - 内容区 p-6，不用 `.card .card-pad` 堆叠。
 *
 * 注意：本组件是医护端**专属**外壳，与老人端共用的 `AppShell` 完全独立，
 * 因此老人端布局与视觉不受任何影响。
 */

interface NavEntry {
  href: string;
  label: string;
  icon: typeof ClipboardList;
  /** 该项是否同时覆盖其下所有子路径（仅根项 /staff 使用） */
  exact?: boolean;
}

const NAV: NavEntry[] = [
  { href: "/staff", label: "评估任务", icon: ClipboardList, exact: true },
  { href: "/staff/patients", label: "患者管理", icon: Users },
  { href: "/staff/quality", label: "质控看板", icon: LayoutDashboard },
  { href: "/staff/knowledge", label: "知识库", icon: Brain },
  { href: "/staff/config", label: "配置与质控", icon: Settings },
];

export function StaffShell({
  user,
  children,
}: {
  user: User | null;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  const handleLogout = () => {
    clearSession();
    router.replace("/login");
  };

  const isActive = (entry: NavEntry) =>
    entry.exact
      ? pathname === entry.href
      : pathname === entry.href || pathname.startsWith(`${entry.href}/`);

  return (
    <div className="flex min-h-screen bg-clin-bg">
      {/* ------------------------------ 侧边栏 ------------------------------ */}
      <aside className="sticky top-0 flex h-screen w-[216px] shrink-0 flex-col border-r border-clin-border bg-clin-surface">
        <div className="border-b border-clin-border px-4 py-4">
          <p className="text-clin-xs text-clin-fg-subtle">老年综合评估工作台</p>
          <p className="mt-1 text-clin-sm font-semibold text-clin-fg">
            医护端控制台
          </p>
        </div>

        <nav className="flex-1 py-2" aria-label="医护端主导航">
          <ul>
            {NAV.map((entry) => {
              const active = isActive(entry);
              const Icon = entry.icon;
              return (
                <li key={entry.href}>
                  <Link
                    href={entry.href}
                    aria-current={active ? "page" : undefined}
                    className={cn(
                      "relative flex h-10 items-center gap-2.5 px-4 text-clin-sm transition-colors duration-150",
                      "border-l-2 border-l-transparent",
                      active
                        ? "border-l-clin-accent bg-clin-accent-soft text-clin-fg"
                        : "text-clin-fg-muted hover:bg-clin-muted hover:text-clin-fg",
                    )}
                  >
                    <Icon
                      className={cn(
                        "h-4 w-4 shrink-0",
                        active ? "text-clin-accent" : "text-clin-fg-subtle",
                      )}
                      aria-hidden="true"
                    />
                    {entry.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>

        <div className="border-t border-clin-border px-4 py-3">
          <p className="truncate text-clin-xs text-clin-fg-muted">
            {user ? `${user.full_name || user.username}（${roleLabel(user.role)}）` : ""}
          </p>
          <button
            type="button"
            onClick={handleLogout}
            className="mt-2 inline-flex items-center gap-1.5 text-clin-xs text-clin-fg-muted transition-colors duration-150 hover:text-clin-danger"
          >
            <LogOut className="h-3.5 w-3.5" aria-hidden="true" />
            退出登录
          </button>
        </div>
      </aside>

      {/* ------------------------------ 内容区 ------------------------------ */}
      <div className="min-w-0 flex-1">
        <div className="p-6">{children}</div>
      </div>
    </div>
  );
}
