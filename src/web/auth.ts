import { createAuth, type Auth } from "../infra/auth/auth";
import { businessDb } from "../infra/do/client";

const cache = new WeakMap<Env, Auth>();

/** Better Auth のインスタンス（環境ごとに1つ作って使い回す） */
export function authFor(env: Env): Auth {
  const cached = cache.get(env);
  if (cached) return cached;
  const auth = createAuth(env, {
    canSignIn: (email) => businessDb(env).authCanSignIn(email),
    link: (email, userId) => businessDb(env).authLinkUser(email, userId),
    isActive: (userId) => businessDb(env).authIsActive(userId),
  });
  cache.set(env, auth);
  return auth;
}
