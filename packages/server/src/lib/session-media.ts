import { db } from "../db/index.js";
import { createSessionMediaService } from "./session-media-service.js";
import { generateUploadUrl, generatePrivateReadUrl, getObjectBufferLimited, putObject, deleteObject, storageKind } from "./s3.js";
import { imageMasters } from "./image-masters.js";
export const sessionMedia = createSessionMediaService(db, {
    signUpload: (key, mime, size, seconds) => generateUploadUrl(key, mime, { contentLength: size, expiresIn: seconds }),
    signRead: generatePrivateReadUrl,
    read: getObjectBufferLimited,
    write: (key, bytes, mime = "image/webp", options) => putObject(key, bytes, mime, { ...options, signal: AbortSignal.timeout(30000) }),
    remove: deleteObject,
}, imageMasters);
/** Kill switch affects new writes only; existing media remains readable. */
export function sessionMediaUploadsEnabled(userId: string, worldId: string) {
    if (storageKind() !== 's3') return false;
    if (process.env.SESSION_MEDIA_UPLOADS_ENABLED === 'false')
        return false;
    if (process.env.SESSION_MEDIA_UPLOADS_ENABLED === 'true')
        return true;
    return (process.env.SESSION_MEDIA_PILOT_USERS ?? '').split(',').map(id=>id.trim()).filter(Boolean).includes(userId)
        || (process.env.SESSION_MEDIA_PILOT_WORLDS ?? '').split(',').map(id=>id.trim()).filter(Boolean).includes(worldId);
}
let sweeping = false;
export function startSessionMediaCleanup() {
    const timer = setInterval(() => {
        if (sweeping)
            return;
        sweeping = true;
        sessionMedia.sweep().catch(() => console.error('[session-media] cleanup failed')).finally(() => { sweeping = false; });
    }, 60000);
    timer.unref();
    return timer;
}
