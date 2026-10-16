import { confirmAction } from "@/components/ui/global-confirm-dialog";
const apiBase = import.meta.env.VITE_API_URL || "";

export interface StudioPreflightIssue {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  entityId?: string;
  evidence?: string;
  fix?: string;
}

export interface StudioPreflightReport {
  clean: boolean;
  blockingErrors: StudioPreflightIssue[];
  warnings: StudioPreflightIssue[];
  analysisComplete: boolean;
}

export async function runStudioPreflight(worldId: string): Promise<StudioPreflightReport> {
  const response = await fetch(`${apiBase}/api/studio/${encodeURIComponent(worldId)}/preflight`, { credentials: "include" });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.data) {
    throw new Error(typeof body?.error === "string" ? body.error : `Preflight failed (HTTP ${response.status}).`);
  }
  return body.data as StudioPreflightReport;
}

export function preflightIssueSummary(issues: StudioPreflightIssue[], limit = 5): string {
  const visible = issues.slice(0, limit).map((issue) => `• ${issue.message}${issue.fix ? ` (${issue.fix})` : ""}`);
  const remaining = issues.length > limit ? `\n• …and ${issues.length - limit} more` : "";
  return visible.join("\n") + remaining;
}

export async function confirmPreflightWarnings(warnings: StudioPreflightIssue[], action: string): Promise<boolean> {
  if (!warnings.length) return true;
  return (await confirmAction(`Preflight found ${warnings.length} warning(s) before ${action}:\n\n${preflightIssueSummary(warnings)}\n\nContinue anyway?`));
}
