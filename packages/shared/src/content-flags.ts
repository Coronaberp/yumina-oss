export const CONTENT_FLAG_VERSION = 1 as const;
export const CONTENT_FLAG_POLICY_ID = "kev-whole-message-v4" as const;
export const CONTENT_FLAG_THRESHOLD = 0.4 as const;
/** Coarse Story provider-routing cutoff; this is intentionally looser than the audit's routingSafe flag. */
export const STORY_SFW_ROUTING_MIN_PROBABILITY = 0.6 as const;
/** Display labels and provider eligibility deliberately use separate cutoffs. */
export const CONTENT_FLAG_MIN_SFW_ROUTING_PROBABILITY = 0.95 as const;
export const CONTENT_FLAG_MAX_NSFW_ROUTING_PROBABILITY = 0.05 as const;
export type ContentFlagStatus = "pending" | "complete" | "error";
export type ContentFlagLabel = "sfw" | "nsfw";
export type ContentFlagAudit = {
    version: 1;
    policyId: typeof CONTENT_FLAG_POLICY_ID | "kev-strict-v1" | "kev-whole-message-v2" | "kev-whole-message-v3";
    classifier: "kev";
    status: ContentFlagStatus;
    label: ContentFlagLabel;
    routingSafe: boolean;
    threshold: 0.4;
    sourceHash: string;
    /** Unique check nonce; prevents an earlier attempt from replacing a retry. */
    requestId?: string;
    startedAt: string;
    completedAt?: string;
    nsfwProbability?: number;
    sfwProbability?: number;
    model?: string;
    device?: "cpu";
    errorCode?: string;
};
export type ContentFlagInspection = {
    threshold: number;
    turn: {
        label: ContentFlagLabel;
        routingSafe: boolean;
        inputMessageId: string | null;
        outputMessageId: string | null;
    };
    messages: Array<{
        id: string;
        role: string;
        activeSwipeIndex: number;
        status: string;
        contentFlags: ContentFlagAudit | null;
    }>;
};
export function isCompleteContentFlag(flag: ContentFlagAudit | null | undefined): flag is ContentFlagAudit & {
    status: "complete";
    completedAt: string;
    nsfwProbability: number;
    sfwProbability: number;
    model: string;
    device: "cpu";
} {
    return !!flag && flag.version === CONTENT_FLAG_VERSION && flag.policyId === CONTENT_FLAG_POLICY_ID && flag.classifier === "kev" && flag.status === "complete" && flag.device === "cpu" && typeof flag.model === "string" && flag.model.length > 0 && typeof flag.sourceHash === "string" && /^[a-f0-9]{64}$/.test(flag.sourceHash) && typeof flag.startedAt === "string" && Number.isFinite(Date.parse(flag.startedAt)) && typeof flag.completedAt === "string" && Number.isFinite(Date.parse(flag.completedAt)) && flag.threshold === CONTENT_FLAG_THRESHOLD && Number.isFinite(flag.nsfwProbability) && Number.isFinite(flag.sfwProbability) && (flag.nsfwProbability as number) >= 0 && (flag.nsfwProbability as number) <= 1 && (flag.sfwProbability as number) >= 0 && (flag.sfwProbability as number) <= 1 && Math.abs((flag.nsfwProbability as number) + (flag.sfwProbability as number) - 1) <= 0.02;
}
export function conservativeRoutingSafe(flag: ContentFlagAudit | null | undefined): boolean {
    return isCompleteContentFlag(flag) && flag.label === "sfw" && flag.routingSafe === true && flag.nsfwProbability <= CONTENT_FLAG_MAX_NSFW_ROUTING_PROBABILITY && flag.sfwProbability >= CONTENT_FLAG_MIN_SFW_ROUTING_PROBABILITY;
}
export function conservativeLabel(flag: ContentFlagAudit | null | undefined): ContentFlagLabel {
    return isCompleteContentFlag(flag) && flag.label === "sfw" && flag.nsfwProbability < CONTENT_FLAG_THRESHOLD ? "sfw" : "nsfw";
}
