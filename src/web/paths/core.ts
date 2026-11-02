import { withQuery, type Query } from "./query";

/** ログインなど共通の画面 */
export const corePaths = {
  home: () => "/",
  login: (query?: Query) => withQuery("/login", query),
  loginGoogle: () => "/login/google",
  logout: () => "/logout",
  noAccess: () => "/no-access",
  devLogin: () => "/dev/login",
};
