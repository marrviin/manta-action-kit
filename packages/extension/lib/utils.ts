/** Utility helpers shared across the extension. */

import classnames from "classnames";

/** Accepted className argument shapes (strings, objects, arrays, falsy values). */
type ClassValue = Parameters<typeof classnames>[number];

/**
 * Join class names, dropping falsy values. Thin wrapper over `classnames` so
 * conditional className assembly never falls back to string concatenation.
 */
export function cn(...classes: ClassValue[]): string {
  return classnames(...classes);
}

/** Generate a RFC4122-ish unique id, preferring the native crypto API. */
export function uuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  // Fallback for older/main-world contexts without randomUUID.
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/** Extract the origin from a URL string, tolerating relative URLs. */
export function originOf(url: string, base?: string): string {
  try {
    return new URL(url, base).origin;
  } catch {
    return '';
  }
}

/** Extract the scheme prefix from a URL, e.g. "https://". Empty when it doesn't parse. */
export function schemeOf(url: string): string {
  try {
    return `${new URL(url).protocol}//`;
  } catch {
    return '';
  }
}

/** Short path+query for display, e.g. "/api/users?page=2". Falls back to the raw url. */
export function shortPath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}

/** Format an epoch-ms timestamp as a compact "MM-DD HH:mm:ss" for list rows. */
export function formatDateTimeShort(at: number): string {
  const d = new Date(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Pretty-print a JSON string; return the original text if it isn't valid JSON. */
export function prettyJson(text: string | null): string {
  if (text == null) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * Format a duration in ms as a compact, human-readable gap between two calls,
 * e.g. "120ms", "1.4s", "2m 5s". Used for the interval shown between timeline nodes.
 */
export function formatGap(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s % 60);
  return `${m}m ${rem}s`;
}
