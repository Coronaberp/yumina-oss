export type SignInMethod = "password" | "github";

export function resolveAuthenticationPolicy(mode: "single-user" | "multi-user", method: SignInMethod, configured: Record<string, boolean>) {
  return {
    mode,
    emailPassword: method !== "github",
    socialProviders: Object.keys(configured).filter(provider => configured[provider] && (method !== "github" || provider === "github")),
  };
}

const passwordPaths = new Set(["/sign-in/email", "/sign-in/username", "/sign-up/email", "/change-password", "/set-password", "/request-password-reset", "/reset-password", "/forget-password", "/unlink-account"]);
export function authenticationMethodBlocked(path: string, method: SignInMethod): boolean {
  if (method !== "github") return false;
  return passwordPaths.has(path.replace(/\/$/, "")) || /^\/callback\/(?!github(?:\/|$))/.test(path);
}
