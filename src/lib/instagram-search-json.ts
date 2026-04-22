import type { InstagramSearchUser } from "../types";

/** Extrai pares { username, fullName } tipicos de respostas de busca do Instagram (GraphQL / REST). */
export function collectUsersFromSearchJson(
  data: unknown,
  out: Map<string, InstagramSearchUser>,
  limit: number,
): void {
  const add = (u: {
    username?: string;
    full_name?: string;
    is_verified?: boolean;
  }): void => {
    if (out.size >= limit) return;
    if (!u || typeof u.username !== "string" || !u.username.trim()) return;
    const username = u.username.trim();
    const key = username.toLowerCase();
    if (out.has(key)) return;
    out.set(key, {
      username,
      fullName: typeof u.full_name === "string" ? u.full_name : "",
      href: `https://www.instagram.com/${encodeURIComponent(username)}/`,
      isVerified: Boolean(u.is_verified),
    });
  };

  const visit = (node: unknown, depth: number): void => {
    if (depth > 30 || out.size >= limit) return;
    if (node == null) return;
    if (Array.isArray(node)) {
      for (const item of node) {
        if (item && typeof item === "object" && "user" in item) {
          const inner = (item as { user?: Record<string, unknown> }).user;
          if (inner && typeof inner === "object") {
            add(inner as { username?: string; full_name?: string; is_verified?: boolean });
          }
        }
        visit(item, depth + 1);
      }
      return;
    }
    if (typeof node === "object") {
      const o = node as Record<string, unknown>;
      if (
        typeof o.username === "string" &&
        o.username.length > 0 &&
        (o.type_name === "User" || o.__typename === "User" || "profile_pic_url" in o)
      ) {
        add({
          username: o.username,
          full_name: typeof o.full_name === "string" ? o.full_name : undefined,
          is_verified: Boolean(o.is_verified),
        });
      }
      for (const v of Object.values(o)) {
        visit(v, depth + 1);
      }
    }
  };

  visit(data, 0);
}
