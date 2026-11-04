"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { clearSession, roleLabel } from "@/lib/session";
import type { User } from "@/lib/types";
import { BigButton } from "./BigButton";

export interface NavItem {
  href: string;
  label: string;
}

/** 顶部栏：左侧标题与导航，右侧用户信息与退出 */
export function AppShell({
  title,
  nav,
  user,
  homeHref,
  children,
}: {
  title: string;
  nav: NavItem[];
  user: User | null;
  homeHref: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  const handleLogout = () => {
    clearSession();
    router.replace("/login");
  };

  return (
    <div className="min-h-screen bg-elderbg">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <Link href={homeHref} className="text-elder-lg font-bold text-medical-800">
            {title}
          </Link>
          <div className="flex items-center gap-3">
            <span className="text-elder text-ink-soft">
              {user ? `${user.full_name || user.username}（${roleLabel(user.role)}）` : ""}
            </span>
            <BigButton variant="ghost" onClick={handleLogout}>
              退出登录
            </BigButton>
          </div>
        </div>
        <nav className="mx-auto max-w-6xl px-4 pb-3">
          <ul className="flex flex-wrap gap-2">
            {nav.map((item) => {
              const active =
                pathname === item.href || pathname.startsWith(`${item.href}/`);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    aria-current={active ? "page" : undefined}
                    className={[
                      "inline-flex min-h-btn items-center rounded-xl border-2 px-4 py-2 text-elder font-semibold transition-colors",
                      active
                        ? "border-medical-700 bg-medical-700 text-white"
                        : "border-slate-300 bg-white text-ink hover:border-medical-400",
                    ].join(" ")}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  );
}
