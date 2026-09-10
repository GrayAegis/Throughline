import { METADATA_KEY, ctx, uid, stamp, log, messageText } from './util.js';

export const STORE_VERSION = 1;

export const CATEGORIES = ['character', 'relationship', 'event', 'item', 'location', 'plot', 'state'];

function emptyStore() {
    return {
        v: STORE_VERSION,
        facts: [],
        spine: { layers: [[]] },
        cursor: 0,
        lineage: { chat: null, parent: null, forkedAt: 0 },
    };
}

/**
 * The store lives in chat metadata, which SillyTavern copies wholesale into every
 * branch and checkpoint it creates. That copy is the entire inheritance mechanism.
 */
export function getStore() {
    const meta = ctx().chatMetadata;
    if (!meta) return emptyStore();
    if (!meta[METADATA_KEY] || typeof meta[METADATA_KEY] !== 'object') {
        meta[METADATA_KEY] = emptyStore();
    }
    const store = meta[METADATA_KEY];
    if (!Array.isArray(store.facts)) store.facts = [];
    if (!store.spine || !Array.isArray(store.spine.layers)) store.spine = { layers: [[]] };
    if (!Array.isArray(store.spine.layers[0])) store.spine.layers[0] = [];
    if (typeof store.cursor !== 'number') store.cursor = 0;
    if (!store.lineage) store.lineage = { chat: null, parent: null, forkedAt: 0 };
    store.v = STORE_VERSION;
    return store;
}

export function saveStore() {
    ctx().saveMetadataDebounced();
}

export async function saveStoreNow() {
    await ctx().saveMetadata();
}

/**
 * Reconcile the inherited store with the chat we just opened.
 *
 * A branch is a prefix of its parent, so anchors below the fork point stay valid and
 * anything anchored past the end belongs to a future this branch never had.
 */
export function syncLineage() {
    const context = ctx();
    const store = getStore();
    const chat = context.chat ?? [];
    const lastIdx = chat.length - 1;
    const chatId = context.getCurrentChatId?.() ?? null;
    let changed = false;

    const keptFacts = store.facts.filter(f => f.since <= lastIdx);
    if (keptFacts.length !== store.facts.length) {
        log(`dropped ${store.facts.length - keptFacts.length} fact(s) anchored past the end of this branch`);
        store.facts = keptFacts;
        changed = true;
    }

    for (const f of store.facts) {
        if (f.until != null && f.until > lastIdx) {
            f.until = null;
            f.supersededBy = null;
            changed = true;
        }
    }

    for (const layer of store.spine.layers) {
        const kept = layer.filter(sn => !Array.isArray(sn.range) || sn.range[0] <= lastIdx);
        if (kept.length !== layer.length) {
            layer.length = 0;
            layer.push(...kept);
            changed = true;
        }
    }

    if (store.cursor > chat.length) {
        store.cursor = chat.length;
        changed = true;
    }

    if (chatId && store.lineage.chat !== chatId) {
        const parent = store.lineage.chat ?? context.chatMetadata?.main_chat ?? null;
        store.lineage = { chat: chatId, parent, forkedAt: chat.length };
        if (parent) log(`inherited memory from "${parent}" at message ${chat.length}`);
        changed = true;
    }

    reanchor(store);

    if (changed) saveStore();
    return store;
}

/** Anchors drift when messages are inserted or removed. Re-find them nearby before giving up. */
function reanchor(store) {
    const chat = ctx().chat ?? [];
    for (const f of store.facts) {
        if (!f.sinceStamp) continue;
        const at = chat[f.since];
        if (at && stamp(messageText(at)) === f.sinceStamp) {
            f.stale = false;
            continue;
        }
        let found = -1;
        for (let d = 1; d <= 6; d++) {
            for (const i of [f.since - d, f.since + d]) {
                if (i < 0 || i >= chat.length) continue;
                if (stamp(messageText(chat[i])) === f.sinceStamp) { found = i; break; }
            }
            if (found !== -1) break;
        }
        if (found !== -1) {
            f.since = found;
            f.stale = false;
        } else {
            f.stale = true;
        }
    }
}

export function activeFacts(store) {
    return store.facts.filter(f => f.until == null);
}

export function isInherited(store, record) {
    return !!record.origin && record.origin !== store.lineage.chat;
}

export function addFact(store, { text, category, entities, knownBy, since, pinned = false }) {
    const chat = ctx().chat ?? [];
    const idx = Math.min(Math.max(0, since ?? chat.length - 1), Math.max(0, chat.length - 1));
    const fact = {
        id: uid('f'),
        text: String(text).trim(),
        category: CATEGORIES.includes(category) ? category : 'event',
        entities: Array.isArray(entities) ? entities.map(String).filter(Boolean) : [],
        knownBy: Array.isArray(knownBy) ? knownBy.map(String).filter(Boolean) : [],
        since: idx,
        sinceStamp: stamp(messageText(chat[idx])),
        until: null,
        supersededBy: null,
        pinned: !!pinned,
        origin: store.lineage.chat,
        ts: Date.now(),
    };
    store.facts.push(fact);
    return fact;
}

/**
 * Facts are never deleted by the extractor, only closed. The range is what lets a
 * branch answer "what was true at message 40" and what keeps divergence honest.
 */
export function retireFact(store, fact, at, supersededBy = null) {
    if (!fact || fact.until != null) return;
    fact.until = at;
    fact.supersededBy = supersededBy;
}

export function addSnippet(store, { text, range, layer = 0 }) {
    while (store.spine.layers.length <= layer) store.spine.layers.push([]);
    const snippet = {
        id: uid('s'),
        text: String(text).trim(),
        range: Array.isArray(range) ? range : null,
        layer,
        origin: store.lineage.chat,
        ts: Date.now(),
    };
    store.spine.layers[layer].push(snippet);
    return snippet;
}

/** Trim the oldest unpinned closed facts once the store runs over its cap. */
export function enforceFactCap(store, maxFacts) {
    if (store.facts.length <= maxFacts) return 0;
    const removable = store.facts
        .filter(f => !f.pinned && f.until != null)
        .sort((a, b) => (a.until ?? 0) - (b.until ?? 0));
    let removed = 0;
    while (store.facts.length > maxFacts && removable.length) {
        const victim = removable.shift();
        const i = store.facts.indexOf(victim);
        if (i !== -1) { store.facts.splice(i, 1); removed++; }
    }
    return removed;
}

export function factsByEntity(store) {
    const map = new Map();
    for (const f of activeFacts(store)) {
        for (const e of (f.entities.length ? f.entities : ['(unattributed)'])) {
            if (!map.has(e)) map.set(e, []);
            map.get(e).push(f);
        }
    }
    return map;
}

export function storeStats(store) {
    const active = activeFacts(store);
    return {
        facts: store.facts.length,
        active: active.length,
        pinned: active.filter(f => f.pinned).length,
        inherited: store.facts.filter(f => isInherited(store, f)).length,
        snippets: store.spine.layers.reduce((n, l) => n + l.length, 0),
        layers: store.spine.layers.filter(l => l.length).length,
        bytes: JSON.stringify(store).length,
    };
}
