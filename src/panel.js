import { ctx, escapeHtml, uid } from './util.js';
import { getSettings } from './settings.js';
import {
    getStore, saveStore, activeFacts, isInherited, storeStats, factsByEntity,
    retireFact, addFact, CATEGORIES,
} from './store.js';
import { buildBlock } from './inject.js';
import { consolidateEntity } from './extract.js';
import { ghostStats } from './ghost.js';

let popup = null;
let root = null;
let activeTab = 'facts';
let filterText = '';
let showRetired = false;

function bytes(n) {
    if (n < 1024) return `${n} B`;
    return `${(n / 1024).toFixed(1)} KB`;
}

function factRow(store, fact) {
    const inherited = isInherited(store, fact);
    const badges = [];
    if (fact.pinned) badges.push('<span class="tl-badge tl-pin">pinned</span>');
    if (inherited) badges.push('<span class="tl-badge tl-inherited">inherited</span>');
    if (fact.merged) badges.push('<span class="tl-badge">merged</span>');
    if (fact.stale) badges.push('<span class="tl-badge tl-stale">anchor lost</span>');
    if (fact.until != null) badges.push('<span class="tl-badge tl-retired">retired</span>');

    const range = fact.until == null ? `from ${fact.since}` : `${fact.since} to ${fact.until}`;
    const knownBy = fact.knownBy?.length ? ` &middot; known by ${escapeHtml(fact.knownBy.join(', '))}` : '';

    return `
    <div class="tl-row ${fact.until != null ? 'tl-row-retired' : ''}" data-id="${fact.id}">
        <div class="tl-row-main">
            <div class="tl-text" data-role="text">${escapeHtml(fact.text)}</div>
            <div class="tl-meta">
                <span class="tl-cat">${escapeHtml(fact.category)}</span>
                <span>${escapeHtml(fact.entities.join(', ') || 'no entities')}</span>
                <span>${range}</span>${knownBy}
                ${badges.join(' ')}
            </div>
        </div>
        <div class="tl-row-actions">
            <div class="menu_button fa-solid fa-thumbtack ${fact.pinned ? 'tl-on' : ''}" data-action="pin" title="${fact.pinned ? 'Unpin' : 'Pin so extraction never retires it'}"></div>
            <div class="menu_button fa-solid fa-pen" data-action="edit" title="Edit"></div>
            <div class="menu_button fa-solid fa-clock-rotate-left" data-action="retire" title="Retire as of now"></div>
            <div class="menu_button fa-solid fa-trash" data-action="delete" title="Delete"></div>
        </div>
    </div>`;
}

function renderFacts(store) {
    const settings = getSettings();
    const needle = filterText.trim().toLowerCase();
    let list = showRetired ? store.facts : activeFacts(store);
    if (needle) {
        list = list.filter(f =>
            f.text.toLowerCase().includes(needle) ||
            f.entities.some(e => e.toLowerCase().includes(needle)) ||
            f.category.includes(needle));
    }
    list = [...list].sort((a, b) => (b.pinned - a.pinned) || (b.since - a.since));

    const entityCounts = [...factsByEntity(store).entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 12);

    const chips = entityCounts.map(([name, facts]) => {
        const over = facts.length > settings.maxFactsPerEntity;
        return `<span class="tl-chip ${over ? 'tl-chip-over' : ''}" data-entity="${escapeHtml(name)}">${escapeHtml(name)} <b>${facts.length}</b></span>`;
    }).join('');

    return `
    <div class="tl-toolbar">
        <input type="text" class="text_pole tl-filter" placeholder="Filter facts" value="${escapeHtml(filterText)}">
        <label class="checkbox_label"><input type="checkbox" class="tl-show-retired" ${showRetired ? 'checked' : ''}> Show retired</label>
        <div class="menu_button" data-action="add-fact">Add fact</div>
    </div>
    <div class="tl-chips">${chips || '<span class="tl-dim">No entities recorded yet.</span>'}</div>
    <div class="tl-list">${list.map(f => factRow(store, f)).join('') || '<div class="tl-dim">Nothing here yet.</div>'}</div>`;
}

function renderSpine(store) {
    const layers = store.spine.layers;
    const blocks = [];
    for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        if (!layer.length) continue;
        const rows = layer.map(sn => `
        <div class="tl-row" data-id="${sn.id}" data-kind="snippet">
            <div class="tl-row-main">
                <div class="tl-text" data-role="text">${escapeHtml(sn.text)}</div>
                <div class="tl-meta">
                    <span>${sn.range ? `messages ${sn.range[0]} to ${sn.range[1]}` : 'no range'}</span>
                    ${isInherited(store, sn) ? '<span class="tl-badge tl-inherited">inherited</span>' : ''}
                </div>
            </div>
            <div class="tl-row-actions">
                <div class="menu_button fa-solid fa-pen" data-action="edit-snippet" title="Edit"></div>
                <div class="menu_button fa-solid fa-trash" data-action="delete-snippet" title="Delete"></div>
            </div>
        </div>`).join('');
        blocks.push(`<div class="tl-layer"><div class="tl-layer-title">Layer ${i}${i === 0 ? ', most recent' : ', compressed'} &middot; ${layer.length}</div>${rows}</div>`);
    }
    return blocks.join('') || '<div class="tl-dim">The spine is empty. It is either disabled or nothing has been summarized yet.</div>';
}

async function renderInjected() {
    const settings = getSettings();
    const block = await buildBlock();
    const ghosts = ghostStats();
    const pct = settings.budgetTokens ? Math.round((block.tokens / settings.budgetTokens) * 100) : 0;
    return `
    <div class="tl-inject-stats">
        <div><b>${block.tokens}</b> tokens of ${settings.budgetTokens} budget, ${pct}%</div>
        <div><b>${block.facts}</b> facts included, <b>${block.dropped}</b> dropped for budget</div>
        <div><b>${block.snippets}</b> spine snippets included</div>
        <div><b>${ghosts.ours}</b> messages hidden by Throughline, <b>${ghosts.theirs}</b> hidden by you</div>
        <div>Injected in chat at depth ${settings.depth}</div>
    </div>
    <pre class="tl-preview">${escapeHtml(block.text) || '<nothing injected>'}</pre>`;
}

async function render() {
    if (!root) return;
    const store = getStore();
    const stats = storeStats(store);
    const lineage = store.lineage;

    const banner = lineage.parent
        ? `Inherited from <b>${escapeHtml(lineage.parent)}</b> at message ${lineage.forkedAt}. ${stats.inherited} of ${stats.facts} records came from before the fork.`
        : 'This is the root chat of the story. Nothing was inherited.';

    const body = activeTab === 'facts'
        ? renderFacts(store)
        : activeTab === 'spine'
            ? renderSpine(store)
            : await renderInjected();

    root.innerHTML = `
    <div class="tl-panel">
        <div class="tl-header">
            <div class="tl-lineage">${banner}</div>
            <div class="tl-stats">
                ${stats.active} active facts &middot; ${stats.pinned} pinned &middot; ${stats.snippets} snippets &middot; store ${bytes(stats.bytes)}
            </div>
        </div>
        <div class="tl-tabs">
            <div class="tl-tab ${activeTab === 'facts' ? 'tl-tab-active' : ''}" data-tab="facts">Facts</div>
            <div class="tl-tab ${activeTab === 'spine' ? 'tl-tab-active' : ''}" data-tab="spine">Spine</div>
            <div class="tl-tab ${activeTab === 'injected' ? 'tl-tab-active' : ''}" data-tab="injected">What gets injected</div>
        </div>
        <div class="tl-body">${body}</div>
    </div>`;
}

function findFact(store, id) {
    return store.facts.find(f => f.id === id) ?? null;
}

function findSnippet(store, id) {
    for (const layer of store.spine.layers) {
        const found = layer.find(sn => sn.id === id);
        if (found) return { snippet: found, layer };
    }
    return null;
}

async function onClick(event) {
    const store = getStore();
    const target = event.target.closest('[data-action], [data-tab], [data-entity]');
    if (!target) return;

    const tab = target.dataset.tab;
    if (tab) {
        activeTab = tab;
        await render();
        return;
    }

    const entity = target.dataset.entity;
    if (entity) {
        const context = ctx();
        const confirmed = await context.Popup.show.confirm(
            `Merge the facts about ${entity} into a smaller set?`,
            'Consolidate',
        );
        if (!confirmed) return;
        const result = await consolidateEntity(entity);
        if (result.ok) toastr.success(`${result.from} facts became ${result.to}`, 'Throughline');
        else toastr.info(result.reason, 'Throughline');
        await render();
        return;
    }

    const action = target.dataset.action;
    const row = target.closest('.tl-row');
    const id = row?.dataset.id;

    if (action === 'add-fact') {
        const text = await ctx().Popup.show.input('New fact', 'One clause, present tense, name people explicitly.');
        if (!text?.trim()) return;
        addFact(store, { text: text.trim(), category: 'state', entities: [], pinned: true });
        saveStore();
        await render();
        return;
    }

    if (!id) return;

    if (action === 'pin') {
        const fact = findFact(store, id);
        if (fact) { fact.pinned = !fact.pinned; saveStore(); }
        await render();
        return;
    }

    if (action === 'edit') {
        const fact = findFact(store, id);
        if (!fact) return;
        const text = await ctx().Popup.show.input('Edit fact', 'The text the model will read.', fact.text);
        if (text?.trim()) { fact.text = text.trim(); saveStore(); }
        await render();
        return;
    }

    if (action === 'retire') {
        const fact = findFact(store, id);
        if (!fact) return;
        retireFact(store, fact, Math.max(0, (ctx().chat?.length ?? 1) - 1));
        saveStore();
        await render();
        return;
    }

    if (action === 'delete') {
        const i = store.facts.findIndex(f => f.id === id);
        if (i !== -1) { store.facts.splice(i, 1); saveStore(); }
        await render();
        return;
    }

    if (action === 'edit-snippet') {
        const found = findSnippet(store, id);
        if (!found) return;
        const text = await ctx().Popup.show.input('Edit summary', 'Plain prose.', found.snippet.text);
        if (text?.trim()) { found.snippet.text = text.trim(); saveStore(); }
        await render();
        return;
    }

    if (action === 'delete-snippet') {
        const found = findSnippet(store, id);
        if (!found) return;
        const i = found.layer.indexOf(found.snippet);
        if (i !== -1) { found.layer.splice(i, 1); saveStore(); }
        await render();
    }
}

function onInput(event) {
    if (event.target.classList.contains('tl-filter')) {
        filterText = event.target.value;
        const store = getStore();
        const list = root.querySelector('.tl-list');
        if (list) {
            const wrapper = document.createElement('div');
            wrapper.innerHTML = renderFacts(store);
            list.innerHTML = wrapper.querySelector('.tl-list').innerHTML;
        }
        return;
    }
    if (event.target.classList.contains('tl-show-retired')) {
        showRetired = event.target.checked;
        render();
    }
}

export async function openPanel() {
    const context = ctx();
    root = document.createElement('div');
    root.classList.add('tl-root');
    root.addEventListener('click', onClick);
    root.addEventListener('input', onInput);
    root.addEventListener('change', onInput);

    await render();

    popup = new context.Popup(root, context.POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        okButton: 'Close',
        allowVerticalScrolling: true,
    });
    await popup.show();
    popup = null;
    root = null;
}

/** Export the whole store as a downloadable file, since there is no lorebook to hand around. */
export function exportStore() {
    const store = getStore();
    const name = ctx().getCurrentChatId?.() ?? 'throughline';
    const blob = new Blob([JSON.stringify(store, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${String(name).replace(/[^\w\- ]+/g, '_')} - throughline.json`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
}

/** Merge a previously exported store into this chat. Records keep their own origin. */
export async function importStore(file) {
    const text = await file.text();
    const incoming = JSON.parse(text);
    const store = getStore();
    let added = 0;

    for (const fact of incoming.facts ?? []) {
        if (store.facts.some(f => f.text === fact.text && f.since === fact.since)) continue;
        store.facts.push({ ...fact, id: uid('f') });
        added++;
    }
    for (const [i, layer] of (incoming.spine?.layers ?? []).entries()) {
        while (store.spine.layers.length <= i) store.spine.layers.push([]);
        for (const sn of layer) {
            if (store.spine.layers[i].some(x => x.text === sn.text)) continue;
            store.spine.layers[i].push({ ...sn, id: uid('s') });
            added++;
        }
    }
    saveStore();
    return added;
}

export { CATEGORIES };
