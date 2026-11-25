/**
 * Invite links (FR-018). The target UID travels in the URL fragment (#join=...),
 * which browsers never send to the web server (GitHub Pages does not see it).
 * Opening a link never connects by itself: the user must click "İstek gönder",
 * and the normal admission flow (approval by every member) still applies.
 */
import { isValidUid, normalizeUid } from "./uid";

const PARAM = "join";

/** Builds an invite URL for `uid` based on the current page location (no hard-coded host). */
export function buildInviteUrl(uid: string, location: { origin: string; pathname: string }): string {
  return `${location.origin}${location.pathname}#${PARAM}=${encodeURIComponent(uid)}`;
}

/** Extracts a valid UID from a location hash such as "#join=psst-…"; null otherwise. */
export function parseInviteHash(hash: string): string | null {
  if (!hash.startsWith("#") || hash.length > 128) return null;
  const params = new URLSearchParams(hash.slice(1));
  const raw = params.get(PARAM);
  if (raw === null) return null;
  const uid = normalizeUid(raw);
  return isValidUid(uid) ? uid : null;
}
