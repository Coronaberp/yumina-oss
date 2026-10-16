import { normalizeVnText, type VnTextPreferences } from "@yumina/shared";
import { useUserProfileStore } from "@/stores/user-profile";

// Serialize full preference snapshots so rapid changes cannot arrive out of order.
let pending: Promise<unknown> = Promise.resolve();
export function saveVnTextPreferences(input: unknown): Promise<VnTextPreferences> {
  const preferences = normalizeVnText(input);
  const ownerId = useUserProfileStore.getState().profile?.id;
  const operation = pending.catch(() => {}).then(async () => {
    if (!ownerId || useUserProfileStore.getState().profile?.id !== ownerId) throw new Error("Sign in to save personal VN settings.");
    const response = await fetch(`${import.meta.env?.VITE_API_URL || ""}/api/users/me`, {
      method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferences: { vnTextPreferences: preferences } }),
    });
    if (!response.ok) throw new Error("Could not save your VN settings. Please retry.");
    // Merge only our namespace. Other profile changes may have completed meanwhile.
    useUserProfileStore.setState(state => state.profile?.id === ownerId ? {
      profile: { ...state.profile, preferences: { ...state.profile.preferences, vnTextPreferences: preferences } },
    } : {});
    return preferences;
  });
  pending = operation;
  return operation;
}
