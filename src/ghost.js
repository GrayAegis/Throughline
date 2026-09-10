import { GHOST_FLAG, ctx, log } from './util.js';
import { getSettings } from './settings.js';
import { getStore } from './store.js';

/**
 * Hiding is what makes the memory worth having: without it the raw history stays in
 * context and nothing is saved. We flag our own hides so a message you hid by hand is
 * never quietly un-hidden by us, and vice versa.
 */
function setHidden(index, hidden) {
    const chat = ctx().chat ?? [];
    const message = chat[index];
    if (!message) return false;
    message.is_system = hidden;
    if (typeof message.extra !== 'object' || message.extra === null) message.extra = {};
    if (hidden) {
        message.extra[GHOST_FLAG] = true;
    } else {
        delete message.extra[GHOST_FLAG];
    }
    const block = document.querySelector(`.mes[mesid="${index}"]`);
    if (block) block.setAttribute('is_system', String(hidden));
    return true;
}

export function isOurGhost(message) {
    return !!message?.extra?.[GHOST_FLAG];
}

/**
 * Hide everything that has been summarized, except the verbatim tail.
 * @returns {Promise<{hidden:number, shown:number}>}
 */
export async function applyGhosting() {
    const settings = getSettings();
    const context = ctx();
    const chat = context.chat ?? [];
    const store = getStore();

    if (!settings.enabled || !settings.ghosting) return { hidden: 0, shown: 0 };

    const verbatimFrom = Math.max(0, chat.length - Math.max(0, settings.verbatimTurns));
    const ghostUpTo = Math.min(store.cursor, verbatimFrom) - 1;

    let hidden = 0;
    let shown = 0;

    for (let i = 0; i < chat.length; i++) {
        const message = chat[i];
        if (!message) continue;
        const ours = isOurGhost(message);
        const shouldHide = i <= ghostUpTo;

        if (shouldHide && !message.is_system) {
            if (setHidden(i, true)) hidden++;
        } else if (!shouldHide && ours && message.is_system) {
            if (setHidden(i, false)) shown++;
        }
    }

    if (hidden || shown) {
        log(`ghosting: hid ${hidden}, restored ${shown}`);
        await context.saveChat();
    }
    return { hidden, shown };
}

/** Restore every message we hid, leaving anything the user hid by hand alone. */
export async function unghostAll() {
    const context = ctx();
    const chat = context.chat ?? [];
    let shown = 0;
    for (let i = 0; i < chat.length; i++) {
        if (isOurGhost(chat[i])) {
            setHidden(i, false);
            shown++;
        }
    }
    if (shown) await context.saveChat();
    return shown;
}

export function ghostStats() {
    const chat = ctx().chat ?? [];
    let ours = 0;
    let theirs = 0;
    for (const m of chat) {
        if (isOurGhost(m)) ours++;
        else if (m?.is_system) theirs++;
    }
    return { ours, theirs, total: chat.length };
}
