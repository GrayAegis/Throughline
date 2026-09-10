import { MODULE, ctx, log, debounce, escapeHtml } from './src/util.js';
import { getSettings, saveSettings, defaultSettings } from './src/settings.js';
import { getStore, syncLineage, storeStats, saveStore } from './src/store.js';
import { runExtraction, pendingRange, isRunning } from './src/extract.js';
import { refreshInjection, getLastBlock } from './src/inject.js';
import { applyGhosting, unghostAll } from './src/ghost.js';
import { openPanel, exportStore, importStore } from './src/panel.js';

const BUTTON_CLASS = 'tl_extract_here';

function notify(message, type = 'info') {
    if (!getSettings().notify) return;
    toastr[type](message, 'Throughline', { timeOut: 3000 });
}

/* ------------------------------------------------------------------ settings UI */

function settingsHtml() {
    return `
    <div class="throughline-settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>Throughline</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="tl-status" id="tl_status"></div>

                <div class="tl-actions">
                    <div class="menu_button" id="tl_open_panel">Memory panel</div>
                    <div class="menu_button" id="tl_extract_now">Extract now</div>
                    <div class="menu_button" id="tl_export">Export</div>
                    <div class="menu_button" id="tl_import">Import</div>
                    <input type="file" id="tl_import_file" accept=".json" style="display:none">
                </div>

                <label class="checkbox_label"><input type="checkbox" id="tl_enabled"> Enabled</label>
                <label class="checkbox_label"><input type="checkbox" id="tl_facts"> Record facts</label>
                <label class="checkbox_label"><input type="checkbox" id="tl_spine"> Record the narrative spine</label>
                <label class="checkbox_label"><input type="checkbox" id="tl_perception"> Track who knows what, and inject only what the scene can know</label>

                <hr>
                <h4>Extraction</h4>
                <label class="checkbox_label"><input type="checkbox" id="tl_auto"> Extract automatically</label>
                <label for="tl_interval">Run after this many new messages</label>
                <input type="number" id="tl_interval" class="text_pole" min="2" max="200">
                <label for="tl_buffer">Hold back this many recent messages</label>
                <input type="number" id="tl_buffer" class="text_pole" min="0" max="50">
                <label for="tl_maxbatch">Largest passage per run, in messages</label>
                <input type="number" id="tl_maxbatch" class="text_pole" min="2" max="200">
                <label for="tl_profile">Connection profile for memory work</label>
                <select id="tl_profile" class="text_pole"></select>
                <label class="checkbox_label"><input type="checkbox" id="tl_schema"> Request structured JSON output</label>
                <label class="checkbox_label"><input type="checkbox" id="tl_debug"> Log prompts and raw responses to the browser console</label>

                <hr>
                <h4>Context</h4>
                <label class="checkbox_label"><input type="checkbox" id="tl_ghosting"> Hide messages once they are remembered</label>
                <label for="tl_verbatim">Keep this many recent messages visible</label>
                <input type="number" id="tl_verbatim" class="text_pole" min="2" max="200">
                <div class="menu_button" id="tl_unghost">Restore every message Throughline hid</div>

                <hr>
                <h4>Injection</h4>
                <label for="tl_budget">Token budget for the memory block</label>
                <input type="number" id="tl_budget" class="text_pole" min="100" max="16000">
                <label for="tl_depth">Injection depth</label>
                <input type="number" id="tl_depth" class="text_pole" min="0" max="100">
                <label for="tl_spineshare">Share of the budget given to the spine, from 0 to 1</label>
                <input type="number" id="tl_spineshare" class="text_pole" min="0" max="1" step="0.05">
                <label for="tl_header">Header line</label>
                <textarea id="tl_header" class="text_pole" rows="2"></textarea>

                <hr>
                <h4>Limits</h4>
                <label for="tl_maxfacts">Maximum facts kept</label>
                <input type="number" id="tl_maxfacts" class="text_pole" min="20" max="5000">
                <label for="tl_perentity">Facts per entity before merging</label>
                <input type="number" id="tl_perentity" class="text_pole" min="3" max="100">

                <hr>
                <h4>Prompts</h4>
                <label for="tl_sysprompt">System prompt</label>
                <textarea id="tl_sysprompt" class="text_pole" rows="4"></textarea>
                <label for="tl_userprompt">Extraction prompt</label>
                <textarea id="tl_userprompt" class="text_pole" rows="10"></textarea>
                <div class="menu_button" id="tl_reset_prompts">Reset prompts to default</div>
            </div>
        </div>
    </div>`;
}

function populateProfiles() {
    const settings = getSettings();
    const profiles = ctx().extensionSettings?.connectionManager?.profiles ?? [];
    const select = document.getElementById('tl_profile');
    if (!select) return;
    select.innerHTML = '<option value="">Current SillyTavern connection</option>' +
        profiles.map(p => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name ?? p.id)}</option>`).join('');
    select.value = settings.profileId ?? '';
}

export function refreshStatus() {
    const el = document.getElementById('tl_status');
    if (!el) return;
    const store = getStore();
    const stats = storeStats(store);
    const pending = pendingRange();
    const block = getLastBlock();
    const settings = getSettings();

    el.innerHTML = `
        <div>${stats.active} active facts, ${stats.pinned} pinned, ${stats.snippets} spine snippets</div>
        <div>Remembered up to message ${Math.max(0, store.cursor - 1)}${pending ? `, ${pending.count} waiting` : ', nothing waiting'}</div>
        <div>Injecting ${block.tokens} tokens of ${settings.budgetTokens}${block.dropped ? `, ${block.dropped} facts dropped` : ''}</div>
        ${store.lineage.parent ? `<div class="tl-dim">Inherited from ${escapeHtml(store.lineage.parent)}</div>` : ''}`;
}

function bindSettings() {
    const settings = getSettings();

    const checkbox = (id, key, after) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.checked = !!settings[key];
        el.addEventListener('change', async () => {
            settings[key] = el.checked;
            saveSettings();
            if (after) await after();
        });
    };

    const number = (id, key, after) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = settings[key];
        el.addEventListener('change', async () => {
            const value = Number(el.value);
            if (!Number.isNaN(value)) settings[key] = value;
            saveSettings();
            if (after) await after();
        });
    };

    const text = (id, key, after) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.value = settings[key];
        el.addEventListener('change', async () => {
            settings[key] = el.value;
            saveSettings();
            if (after) await after();
        });
    };

    const reinject = async () => { await refreshInjection(); refreshStatus(); };

    checkbox('tl_enabled', 'enabled', reinject);
    checkbox('tl_facts', 'factsEnabled', reinject);
    checkbox('tl_spine', 'spineEnabled', reinject);
    checkbox('tl_perception', 'perception', reinject);
    checkbox('tl_auto', 'autoExtract');
    checkbox('tl_schema', 'useJsonSchema');
    checkbox('tl_debug', 'debug');
    checkbox('tl_ghosting', 'ghosting', async () => {
        if (!settings.ghosting) await unghostAll();
        else await applyGhosting();
    });

    number('tl_interval', 'interval', refreshStatus);
    number('tl_buffer', 'buffer', refreshStatus);
    number('tl_maxbatch', 'maxBatch');
    number('tl_verbatim', 'verbatimTurns', async () => { await applyGhosting(); refreshStatus(); });
    number('tl_budget', 'budgetTokens', reinject);
    number('tl_depth', 'depth', reinject);
    number('tl_spineshare', 'spineShare', reinject);
    number('tl_maxfacts', 'maxFacts');
    number('tl_perentity', 'maxFactsPerEntity');

    text('tl_header', 'injectionHeader', reinject);
    text('tl_sysprompt', 'systemPrompt');
    text('tl_userprompt', 'userPrompt');

    const profile = document.getElementById('tl_profile');
    profile?.addEventListener('change', () => {
        settings.profileId = profile.value;
        saveSettings();
    });

    document.getElementById('tl_open_panel')?.addEventListener('click', async () => {
        await openPanel();
        await refreshInjection();
        refreshStatus();
    });

    document.getElementById('tl_extract_now')?.addEventListener('click', () => extractAndApply(null, true));

    document.getElementById('tl_unghost')?.addEventListener('click', async () => {
        const shown = await unghostAll();
        notify(`Restored ${shown} messages`);
    });

    document.getElementById('tl_export')?.addEventListener('click', exportStore);

    document.getElementById('tl_import')?.addEventListener('click', () => {
        document.getElementById('tl_import_file')?.click();
    });

    document.getElementById('tl_import_file')?.addEventListener('change', async (event) => {
        const file = event.target.files?.[0];
        if (!file) return;
        try {
            const added = await importStore(file);
            notify(`Imported ${added} records`, 'success');
            await refreshInjection();
            refreshStatus();
        } catch (error) {
            notify(`Import failed: ${error.message}`, 'error');
        }
        event.target.value = '';
    });

    document.getElementById('tl_reset_prompts')?.addEventListener('click', () => {
        settings.systemPrompt = defaultSettings.systemPrompt;
        settings.userPrompt = defaultSettings.userPrompt;
        settings.consolidatePrompt = defaultSettings.consolidatePrompt;
        settings.promotePrompt = defaultSettings.promotePrompt;
        saveSettings();
        const sys = document.getElementById('tl_sysprompt');
        const usr = document.getElementById('tl_userprompt');
        if (sys) sys.value = settings.systemPrompt;
        if (usr) usr.value = settings.userPrompt;
        notify('Prompts reset');
    });
}

/* ------------------------------------------------------------------ pipeline */

/**
 * One full cycle: extract, hide what is now remembered, rebuild the injected block.
 */
async function extractAndApply(range = null, manual = false) {
    const settings = getSettings();
    if (!settings.enabled) return;
    if (isRunning()) {
        if (manual) notify('Already running');
        return;
    }

    const result = await runExtraction(range);
    if (!result.ok) {
        // A failed run leaves the passage pending, so say so even when it was automatic.
        const quiet = !manual && (result.reason === 'nothing to process' || result.reason === 'already running');
        if (!quiet) toastr.warning(`Extraction failed: ${result.reason}`, 'Throughline', { timeOut: 8000 });
        return;
    }

    await applyGhosting();
    await refreshInjection();
    refreshStatus();

    const span = `messages ${result.range.start} to ${result.range.end}`;
    const bits = [];
    if (result.added) bits.push(`${result.added} facts`);
    if (result.retired) bits.push(`${result.retired} retired`);
    if (result.snippet) bits.push('spine updated');
    notify(bits.length ? `Remembered ${span}: ${bits.join(', ')}` : `Nothing durable in ${span}`, 'success');
}

const maybeAutoExtract = debounce(async () => {
    const settings = getSettings();
    if (!settings.enabled || !settings.autoExtract) return;
    const pending = pendingRange();
    if (!pending || pending.count < settings.interval) return;
    await extractAndApply();
}, 1200);

const onChatEvent = debounce(async () => {
    if (!getSettings().enabled) return;
    await refreshInjection();
    refreshStatus();
}, 400);

/* ------------------------------------------------------------------ message button */

function addMessageButtons() {
    const containers = document.querySelectorAll('#chat .mes .extraMesButtons');
    for (const container of containers) {
        if (container.querySelector(`.${BUTTON_CLASS}`)) continue;
        const button = document.createElement('div');
        button.title = 'Remember everything up to here';
        button.className = `mes_button ${BUTTON_CLASS} fa-solid fa-brain`;
        container.prepend(button);
    }
}

/**
 * Messages are printed in bulk on chat load, well after CHAT_CHANGED, and the render
 * events only fire for messages added afterwards. Watching the container catches both.
 */
function watchChatForButtons() {
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;
    const sweep = debounce(addMessageButtons, 150);
    new MutationObserver(sweep).observe(chatEl, { childList: true, subtree: true });
    sweep();
}

async function onMessageButtonClick(event) {
    const button = event.target.closest(`.${BUTTON_CLASS}`);
    if (!button) return;
    const message = button.closest('.mes');
    const end = Number(message?.getAttribute('mesid'));
    if (Number.isNaN(end)) return;

    const store = getStore();
    if (end < store.cursor) {
        notify('That passage is already remembered');
        return;
    }
    await extractAndApply({ start: store.cursor, end }, true);
}

/* ------------------------------------------------------------------ slash commands */

function registerCommands() {
    const context = ctx();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = context;
    if (!SlashCommandParser?.addCommandObject) return;

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tl-extract',
        helpString: 'Run a Throughline extraction over everything not yet remembered.',
        callback: async () => { await extractAndApply(null, true); return ''; },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tl-panel',
        helpString: 'Open the Throughline memory panel.',
        callback: async () => { await openPanel(); return ''; },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tl-note',
        helpString: 'Record a fact by hand. It is pinned, so extraction will never retire it.',
        unnamedArgumentList: [
            SlashCommandArgument.fromProps({ description: 'the fact', typeList: [ARGUMENT_TYPE.STRING], isRequired: true }),
        ],
        callback: async (_args, value) => {
            const text = String(value ?? '').trim();
            if (!text) return '';
            const { addFact } = await import('./src/store.js');
            const store = getStore();
            addFact(store, { text, category: 'state', entities: [], pinned: true });
            saveStore();
            await refreshInjection();
            refreshStatus();
            notify('Fact recorded', 'success');
            return '';
        },
    }));

    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'tl-preview',
        helpString: 'Return the memory block currently being injected.',
        callback: async () => (await refreshInjection()).text,
    }));
}

/* ------------------------------------------------------------------ boot */

function registerMacros() {
    const context = ctx();
    context.registerMacro?.('throughline', () => getLastBlock().text);
    context.registerMacro?.('throughline_tokens', () => String(getLastBlock().tokens));
}

jQuery(async () => {
    const context = ctx();
    const { eventSource, eventTypes } = context;

    document.getElementById('extensions_settings2')?.insertAdjacentHTML('beforeend', settingsHtml());
    bindSettings();
    populateProfiles();
    registerCommands();
    registerMacros();

    document.getElementById('chat')?.addEventListener('click', onMessageButtonClick);
    watchChatForButtons();

    eventSource.on(eventTypes.APP_READY, () => {
        populateProfiles();
        syncLineage();
        onChatEvent();
    });

    eventSource.on(eventTypes.CHAT_CHANGED, async () => {
        syncLineage();
        addMessageButtons();
        await refreshInjection();
        refreshStatus();
    });

    eventSource.on(eventTypes.MESSAGE_RECEIVED, () => { onChatEvent(); maybeAutoExtract(); });
    eventSource.on(eventTypes.MESSAGE_SENT, () => { onChatEvent(); });

    for (const event of [eventTypes.MESSAGE_DELETED, eventTypes.MESSAGE_EDITED, eventTypes.MESSAGE_SWIPED]) {
        eventSource.on(event, () => { syncLineage(); onChatEvent(); });
    }

    log(`loaded, storing under chat metadata key "${MODULE}"`);
});
