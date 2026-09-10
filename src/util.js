export const MODULE = 'throughline';
export const METADATA_KEY = 'throughline';
export const PROMPT_KEY = 'THROUGHLINE';
export const GHOST_FLAG = 'tl_ghosted';

/** @returns {any} SillyTavern context */
export const ctx = () => SillyTavern.getContext();

export function log(...args) {
    console.log('[Throughline]', ...args);
}

export function warn(...args) {
    console.warn('[Throughline]', ...args);
}

let counter = 0;
export function uid(prefix = 'f') {
    counter += 1;
    return `${prefix}${Date.now().toString(36)}${counter.toString(36)}`;
}

/** Cheap stable hash of a message, used to detect that an anchor still points at the same text. */
export function stamp(text) {
    const s = String(text ?? '').slice(0, 160);
    let h = 5381;
    for (let i = 0; i < s.length; i++) {
        h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    return (h >>> 0).toString(36);
}

export function debounce(fn, ms = 300) {
    let t = null;
    return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
    };
}

export function escapeHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Parse JSON out of a model response that may be fenced, prefixed, or trailed with prose.
 * @param {string} raw
 * @returns {object|null}
 */
export function parseJsonLoose(raw) {
    if (!raw) return null;
    let text = String(raw).trim();

    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fence) text = fence[1].trim();

    try {
        return JSON.parse(text);
    } catch { /* fall through to brace scanning */ }

    const start = text.indexOf('{');
    if (start === -1) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const c = text[i];
        if (escaped) { escaped = false; continue; }
        if (c === '\\') { escaped = true; continue; }
        if (c === '"') { inString = !inString; continue; }
        if (inString) continue;
        if (c === '{') depth++;
        if (c === '}') {
            depth--;
            if (depth === 0) {
                try {
                    return JSON.parse(text.slice(start, i + 1));
                } catch {
                    return null;
                }
            }
        }
    }
    return null;
}

/** Names spoken in the tail of the chat, used for perception filtering and relevance. */
export function recentSpeakers(depth = 8) {
    const chat = ctx().chat ?? [];
    const names = new Set();
    for (let i = Math.max(0, chat.length - depth); i < chat.length; i++) {
        const m = chat[i];
        if (m?.name) names.add(String(m.name));
    }
    return [...names];
}

/** Plain text of a message with reasoning and macros left alone but markup trimmed. */
export function messageText(m) {
    return String(m?.mes ?? '').replace(/\r/g, '').trim();
}
