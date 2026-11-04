import type { Role, User } from "./types";

export const TOKEN_KEY = "wfdn_token";
export const USER_KEY = "wfdn_user";

/** 角色对应的首页 */
export function homePathForRole(role: Role | undefined | null): string {
  return role === "elder" ? "/elder" : "/staff";
}

/** 角色中文名 */
export function roleLabel(role: Role | undefined | null): string {
  switch (role) {
    case "elder":
      return "老人/家属";
    case "staff":
      return "评估人员";
    case "doctor":
      return "医生";
    case "admin":
      return "系统管理员";
    default:
      return "未知角色";
  }
}

/** 是否属于医护侧角色 */
export function isStaffRole(role: Role | undefined | null): boolean {
  return role === "staff" || role === "doctor" || role === "admin";
}

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(TOKEN_KEY, token);
}

export function getStoredUser(): User | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(USER_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as User;
  } catch {
    return null;
  }
}

export function setStoredUser(user: User): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(USER_KEY, JSON.stringify(user));
}

/** 清空登录态（登出、401 失效） */
export function clearSession(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(TOKEN_KEY);
    window.localStorage.removeItem(USER_KEY);
  } catch {
    /* 忽略存储异常 */
  }
}
