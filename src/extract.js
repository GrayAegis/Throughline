import { ctx, log, warn, parseJsonLoose, messageText, GHOST_FLAG } from './util.js';
import { getSettings } from './settings.js';
import {
    getStore, saveStore, addFact, retireFact, addSnippet, activeFacts,
    enforceFactCap, CATEGORIES,
} from './store.js';

let running = false;
export const isRunning = () => running;

const EXTRACTION_SCHEMA = {
    name: 'throughline_extraction',
    description: 'Durable story state extracted from a roleplay passage',
    value: {
        type: 'object',
        properties: {
            spine: { type: 'string' },
            facts: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        text: { type: 'string' },
                        category: { type: 'string', enum: CATEGORIES },
                        entities: { type: 'array', items: { type: 'string' } },
                        knownBy: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['text', 'category', 'entities'],
                },
            },
            retire: { type: 'array', items: { type: 'integer' } },
        },
        required: ['spine', 'facts', 'retire'],
    },
};

/** The window of unprocessed messages, held back by the buffer so the tail stays live. */
export function pendingRange() {
    const settings = getSettings();
    const store = getStore();
    const chat = ctx().chat ?? [];
    const start = Math.max(0, store.cursor);
    const end = chat.length - 1 - Math.max(0, settings.buffer);
    if (end < start) return null;
    const capped = Math.min(end, start + Math.max(1, settings.maxBatch) - 1);
    return { start, end: capped, count: capped - start + 1 };
}

function buildDigest(store, limit = 80) {
    const active = activeFacts(store);
    const ordered = [...active].sort((a, b) => (b.pinned - a.pinned) || (b.since - a.since));
    const shown = ordered.slice(0, limit);
    const lines = shown.map((f, i) => `[${i}] (${f.category}) ${f.text}`);
    return { text: lines.join('\n') || '(nothing recorded yet)', index: shown };
}

function buildSpineContext(store, limit = 6) {
    const layers = store.spine.layers;
    const out = [];
    for (let i = layers.length - 1; i >= 1; i--) {
        for (const sn of layers[i]) out.push(sn.text);
    }
    const recent = layers[0].slice(-limit).map(sn => sn.text);
    out.push(...recent);
    return out.join('\n') || '(nothing recorded yet)';
}

function buildTranscript(start, end) {
    const chat = ctx().chat ?? [];
    const lines = [];
    for (let i = start; i <= end; i++) {
        const m = chat[i];
        if (!m) continue;
        // Skip what the user excluded from the prompt by hand. Our own hides sit below the cursor.
        if (m.is_system && !m.extra?.[GHOST_FLAG]) continue;
        const text = messageText(m);
        if (!text) continue;
        lines.push(`[${i}] ${m.name}: ${text}`);
    }
    return lines.join('\n\n');
}

function fill(template, vars) {
    return Object.entries(vars).reduce(
        (acc, [k, v]) => acc.replaceAll(`{{${k}}}`, String(v ?? '')),
        String(template ?? ''),
    );
}

/**
 * One call, over whichever connection the user picked. A named profile keeps memory work
 * off the model doing the roleplay; the empty profile uses the live connection through
 * generateRaw, which sends only this prompt rather than the whole chat with it appended.
 *
 * Returns either a string or, when SillyTavern has already parsed structured output, an object.
 */
async function callModel(system, user, { schema = null, maxTokens } = {}) {
    const context = ctx();
    const settings = getSettings();
    const profileId = settings.profileId;
    const responseLength = maxTokens ?? settings.maxResponseTokens;

    if (settings.debug) log('prompt >>>\n' + system + '\n\n' + user);

    let result;
    if (profileId) {
        const messages = [
            { role: 'system', content: system },
            { role: 'user', content: user },
        ];
        const extracted = await context.ConnectionManagerRequestService.sendRequest(
            profileId,
            messages,
            responseLength,
            { stream: false, extractData: true },
            schema ? { json_schema: schema } : {},
        );
        // With a schema the service hands back content already parsed into an object.
        result = (extracted && typeof extracted === 'object' && 'content' in extracted) ? extracted.content : extracted;
    } else {
        result = await context.generateRaw({
            prompt: user,
            systemPrompt: system,
            responseLength,
            jsonSchema: schema,
        });
    }

    if (settings.debug) log('response <<<', result);
    return result;
}

/**
 * Turn whatever came back into the extraction object, or null if it is not one.
 *
 * SillyTavern's JSON extractor returns the string "{}" when it finds no JSON at all, so an
 * empty object is a failed call, not a passage with nothing in it. A real "nothing new"
 * answer still carries the keys. Some providers also wrap the payload one level deep.
 */
export function interpretResponse(raw) {
    let parsed = raw;
    if (typeof raw === 'string') parsed = parseJsonLoose(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

    const looksRight = (obj) => obj && typeof obj === 'object' && (Array.isArray(obj.facts) || typeof obj.spine === 'string');

    if (!looksRight(parsed)) {
        const inner = Object.values(parsed).find(looksRight);
        if (!inner) return null;
        parsed = inner;
    }

    return {
        spine: typeof parsed.spine === 'string' ? parsed.spine : '',
        facts: Array.isArray(parsed.facts) ? parsed.facts : [],
        retire: Array.isArray(parsed.retire) ? parsed.retire : [],
    };
}

/**
 * Run one extraction pass over the pending window.
 * @param {{start:number,end:number}} [range] Explicit range, for manual runs.
 */
export async function runExtraction(range = null) {
    const settings = getSettings();
    if (running) return { ok: false, reason: 'already running' };
    if (!settings.factsEnabled && !settings.spineEnabled) return { ok: false, reason: 'nothing enabled' };

    const window = range ?? pendingRange();
    if (!window) return { ok: false, reason: 'nothing to process' };

    const store = getStore();
    const transcript = buildTranscript(window.start, window.end);
    if (!transcript.trim()) {
        store.cursor = Math.max(store.cursor, window.end + 1);
        saveStore();
        return { ok: false, reason: 'passage is empty' };
    }

    running = true;
    try {
        const digest = buildDigest(store);
        const user = fill(settings.userPrompt, {
            digest: digest.text,
            spine: settings.spineEnabled ? buildSpineContext(store) : '(disabled)',
            transcript,
            user: ctx().name1 ?? 'the player',
            char: ctx().name2 ?? 'the character',
        });

        const raw = await callModel(settings.systemPrompt, user, {
            schema: settings.useJsonSchema ? EXTRACTION_SCHEMA : null,
        });

        const parsed = interpretResponse(raw);
        if (!parsed) {
            warn('extraction response was not usable, leaving the passage for next time. Raw response:', raw);
            const hint = settings.useJsonSchema
                ? ' Turn on debug logging to see the raw response, or try turning off structured JSON output.'
                : ' Turn on debug logging to see the raw response.';
            return { ok: false, reason: 'the model did not return a usable extraction.' + hint, range: window };
        }

        let added = 0;
        let retired = 0;

        if (settings.factsEnabled && Array.isArray(parsed.facts)) {
            for (const item of parsed.facts) {
                const text = String(item?.text ?? '').trim();
                if (!text) continue;
                addFact(store, {
                    text,
                    category: item.category,
                    entities: item.entities,
                    knownBy: settings.perception ? item.knownBy : [],
                    since: window.end,
                });
                added++;
            }
        }

        if (settings.factsEnabled && Array.isArray(parsed.retire)) {
            for (const i of parsed.retire) {
                const target = digest.index[Number(i)];
                if (!target || target.pinned) continue;
                retireFact(store, target, window.end);
                retired++;
            }
        }

        let snippet = null;
        if (settings.spineEnabled) {
            const text = String(parsed.spine ?? '').trim();
            if (text) snippet = addSnippet(store, { text, range: [window.start, window.end] });
        }

        store.cursor = Math.max(store.cursor, window.end + 1);
        enforceFactCap(store, settings.maxFacts);
        saveStore();

        await maybePromote(0);
        await maybeConsolidate();

        log(`extracted messages ${window.start} to ${window.end}: added ${added}, retired ${retired}`);
        return { ok: true, added, retired, snippet: !!snippet, range: window };
    } catch (error) {
        warn('extraction failed', error);
        return { ok: false, reason: error?.message ?? 'extraction failed' };
    } finally {
        running = false;
    }
}

/** Fold the oldest snippets of a full layer into one snippet on the layer above. */
async function maybePromote(layer) {
    const settings = getSettings();
    const store = getStore();
    if (!settings.spineEnabled) return;
    if (layer >= settings.maxLayers - 1) return;

    const source = store.spine.layers[layer];
    if (!source || source.length < settings.snippetsPerLayer) return;

    const batch = source.slice(0, settings.snippetsPerPromotion);
    if (batch.length < 2) return;

    const prompt = fill(settings.promotePrompt, {
        snippets: batch.map((sn, i) => `${i + 1}. ${sn.text}`).join('\n'),
    });

    try {
        const raw = await callModel(settings.systemPrompt, prompt, { maxTokens: 600 });
        const text = String(raw ?? '').trim();
        if (!text) return;

        const range = [batch[0].range?.[0] ?? 0, batch.at(-1).range?.[1] ?? 0];
        addSnippet(store, { text, range, layer: layer + 1 });
        source.splice(0, batch.length);
        saveStore();
        log(`promoted ${batch.length} snippets from layer ${layer} to layer ${layer + 1}`);
        await maybePromote(layer + 1);
    } catch (error) {
        warn('promotion failed', error);
    }
}

/** Merge an entity's facts back under its cap. This is consolidation, unattended. */
async function maybeConsolidate() {
    const settings = getSettings();
    const store = getStore();
    if (!settings.factsEnabled) return;

    const counts = new Map();
    for (const f of activeFacts(store)) {
        for (const e of f.entities) counts.set(e, (counts.get(e) ?? 0) + 1);
    }
    const over = [...counts.entries()].find(([, n]) => n > settings.maxFactsPerEntity);
    if (!over) return;

    await consolidateEntity(over[0]);
}

export async function consolidateEntity(entity) {
    const settings = getSettings();
    const store = getStore();
    const target = Math.max(3, Math.floor(settings.maxFactsPerEntity * 0.6));
    const subject = activeFacts(store).filter(f => f.entities.includes(entity) && !f.pinned);
    if (subject.length <= target) return { ok: false, reason: 'already within cap' };

    const prompt = fill(settings.consolidatePrompt, {
        entity,
        target,
        facts: subject.map((f, i) => `${i + 1}. (${f.category}) ${f.text}`).join('\n'),
    });

    try {
        const raw = await callModel(settings.systemPrompt, prompt, { maxTokens: 900 });
        const parsed = parseJsonLoose(raw);
        if (!parsed || !Array.isArray(parsed.facts) || !parsed.facts.length) {
            return { ok: false, reason: 'the model did not return usable JSON' };
        }

        const at = Math.max(0, (ctx().chat?.length ?? 1) - 1);
        const earliest = Math.min(...subject.map(f => f.since));
        for (const f of subject) retireFact(store, f, at);
        for (const item of parsed.facts) {
            const text = String(item?.text ?? '').trim();
            if (!text) continue;
            const fact = addFact(store, {
                text,
                category: item.category,
                entities: item.entities?.length ? item.entities : [entity],
                since: earliest,
            });
            fact.merged = true;
        }
        saveStore();
        log(`consolidated ${subject.length} facts about ${entity} into ${parsed.facts.length}`);
        return { ok: true, from: subject.length, to: parsed.facts.length };
    } catch (error) {
        warn('consolidation failed', error);
        return { ok: false, reason: error?.message ?? 'consolidation failed' };
    }
}
