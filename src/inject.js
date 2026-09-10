import { PROMPT_KEY, ctx, recentSpeakers, messageText } from './util.js';
import { getSettings } from './settings.js';
import { getStore, activeFacts } from './store.js';

const IN_CHAT = 1;

let lastBlock = { text: '', tokens: 0, facts: 0, snippets: 0, dropped: 0 };
export const getLastBlock = () => lastBlock;

const CATEGORY_ORDER = ['character', 'relationship', 'state', 'item', 'location', 'plot', 'event'];

/**
 * Rank facts for a budget that will not fit all of them.
 * Pinned first, then whoever is actually in the scene, then how recently it became true.
 */
function scoreFact(fact, { participants, mentioned, latest }) {
    let score = 0;
    if (fact.pinned) score += 10000;
    if (fact.entities.some(e => participants.has(e.toLowerCase()))) score += 500;
    if (fact.entities.some(e => mentioned.has(e.toLowerCase()))) score += 250;
    if (fact.merged) score += 40;
    score += latest > 0 ? Math.round((fact.since / latest) * 100) : 0;
    if (fact.stale) score -= 150;
    return score;
}

/** Words appearing in the recent tail, used to notice entities the scene is talking about. */
function mentionedEntities(depth = 6) {
    const chat = ctx().chat ?? [];
    const text = chat
        .slice(Math.max(0, chat.length - depth))
        .map(m => messageText(m))
        .join(' ')
        .toLowerCase();
    return text;
}

function visibleToScene(fact, participants) {
    if (!fact.knownBy?.length) return true;
    return fact.knownBy.some(name => participants.has(String(name).toLowerCase()));
}

async function fits(text, budget) {
    const tokens = await ctx().getTokenCountAsync(text);
    return { tokens, ok: tokens <= budget };
}

/**
 * Compose the block the model actually sees. Facts are grouped by category so the model
 * reads state rather than a flat list, and the spine follows as narrative.
 */
export async function buildBlock() {
    const settings = getSettings();
    const store = getStore();
    const context = ctx();

    if (!settings.enabled) return { text: '', tokens: 0, facts: 0, snippets: 0, dropped: 0 };

    const speakers = recentSpeakers(8).map(n => n.toLowerCase());
    const participants = new Set([...speakers, String(context.name1 ?? '').toLowerCase(), String(context.name2 ?? '').toLowerCase()].filter(Boolean));
    const tail = mentionedEntities();
    const mentioned = new Set();
    const latest = Math.max(1, (context.chat?.length ?? 1) - 1);

    let candidates = settings.factsEnabled ? activeFacts(store) : [];
    for (const f of candidates) {
        for (const e of f.entities) {
            if (e && tail.includes(e.toLowerCase())) mentioned.add(e.toLowerCase());
        }
    }
    if (settings.perception) {
        candidates = candidates.filter(f => visibleToScene(f, participants));
    }

    const ranked = [...candidates].sort(
        (a, b) => scoreFact(b, { participants, mentioned, latest }) - scoreFact(a, { participants, mentioned, latest }),
    );

    const totalBudget = Math.max(0, settings.budgetTokens);
    const spineBudget = settings.spineEnabled ? Math.floor(totalBudget * settings.spineShare) : 0;
    const factBudget = totalBudget - spineBudget;

    const chosen = [];
    let dropped = 0;
    let used = 0;
    for (const fact of ranked) {
        const line = `- ${fact.text}`;
        const cost = await context.getTokenCountAsync(line);
        if (used + cost > factBudget) { dropped++; continue; }
        chosen.push(fact);
        used += cost;
    }

    const spineLines = [];
    if (settings.spineEnabled) {
        const layers = store.spine.layers;
        const ordered = [];
        for (let i = layers.length - 1; i >= 1; i--) ordered.push(...layers[i]);
        ordered.push(...layers[0]);

        let spineUsed = 0;
        const tailFirst = [...ordered].reverse();
        const keep = [];
        for (const sn of tailFirst) {
            const cost = await context.getTokenCountAsync(sn.text);
            if (spineUsed + cost > spineBudget) break;
            keep.unshift(sn);
            spineUsed += cost;
        }
        spineLines.push(...keep.map(sn => sn.text));
    }

    if (!chosen.length && !spineLines.length) {
        lastBlock = { text: '', tokens: 0, facts: 0, snippets: 0, dropped };
        return lastBlock;
    }

    const parts = [];
    parts.push(settings.injectionHeader);

    if (chosen.length) {
        parts.push('');
        const byCategory = new Map();
        for (const f of chosen) {
            if (!byCategory.has(f.category)) byCategory.set(f.category, []);
            byCategory.get(f.category).push(f);
        }
        const order = [...CATEGORY_ORDER, ...[...byCategory.keys()].filter(c => !CATEGORY_ORDER.includes(c))];
        for (const category of order) {
            const list = byCategory.get(category);
            if (!list?.length) continue;
            parts.push(`${category.charAt(0).toUpperCase()}${category.slice(1)}:`);
            for (const f of list) parts.push(`- ${f.text}`);
            parts.push('');
        }
    }

    if (spineLines.length) {
        parts.push('What has happened:');
        parts.push(...spineLines);
    }

    const body = parts.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    const text = `<story_memory>\n${body}\n</story_memory>`;
    const { tokens } = await fits(text, totalBudget);

    lastBlock = { text, tokens, facts: chosen.length, snippets: spineLines.length, dropped };
    return lastBlock;
}

/** Rebuild and hand the block to SillyTavern's injection slot. */
export async function refreshInjection() {
    const settings = getSettings();
    const context = ctx();

    if (!settings.enabled) {
        context.setExtensionPrompt(PROMPT_KEY, '', IN_CHAT, 0, false, 0);
        return lastBlock;
    }

    const block = await buildBlock();
    context.setExtensionPrompt(
        PROMPT_KEY,
        block.text,
        IN_CHAT,
        Math.max(0, settings.depth),
        false,
        Number(settings.role ?? 0),
    );
    return block;
}
