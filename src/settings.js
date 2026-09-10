import { MODULE, ctx } from './util.js';

export const EXTRACT_SYSTEM_PROMPT =
`You extract durable story state from a roleplay transcript.
You reply with a single JSON object and nothing else. No preamble, no markdown fence, no commentary.
You never record anything the transcript does not support. You do not speculate about what characters are thinking unless they said or clearly showed it.`;

export const EXTRACT_USER_PROMPT =
`## Known facts
Facts already recorded. Do not repeat them. Refer to them by index when retiring.
{{digest}}

## Story so far
{{spine}}

## New passage
The passage below is new since the last extraction. {{user}} is the human player.
{{transcript}}

## Task
Return JSON with this shape:
{
  "spine": "one to three sentences covering what happened in the passage",
  "facts": [ { "text": "", "category": "", "entities": [], "knownBy": [] } ],
  "retire": [ ]
}

Rules for "spine":
- Write only what is new. Do not re-establish people, places, or relationships already in Known facts or Story so far.
- Plain past tense prose. Name people explicitly instead of using pronouns.
- Omit atmosphere and description. Keep decisions, actions, reversals, and arrivals.
- If nothing of consequence happened, return an empty string.

Rules for "facts":
- A fact is something that stays true after this scene ends. Ongoing state, not a moment.
- One clause each, present tense, under twenty words, every person named explicitly.
- "category" is one of: character, relationship, event, item, location, plot, state.
- "entities" lists the people, places, or things the fact is about, by name.
- "knownBy" lists characters who know this fact. Leave it empty when it is common knowledge or when nobody is being kept in the dark.
- Record nothing already present in Known facts. An empty array is a correct answer.

Rules for "retire":
- List the indexes of Known facts that this passage contradicts, resolves, or ends.
- Retire a fact when it stops being true, not when it merely stops being mentioned.`;

export const CONSOLIDATE_PROMPT =
`Below are recorded facts about {{entity}}. There are too many to carry.

{{facts}}

Rewrite them as at most {{target}} facts that preserve every load-bearing detail.
Merge overlapping facts. Drop what is implied by another fact. Keep specific names, numbers, and commitments.
Reply with a single JSON object and nothing else: { "facts": [ { "text": "", "category": "", "entities": [] } ] }`;

export const PROMOTE_PROMPT =
`Below are consecutive summaries from one story, oldest first.

{{snippets}}

Compress them into a single summary covering the whole span.
Keep decisions, reversals, arrivals, departures, and anything a later scene would need to reference. Drop repetition and atmosphere.
Write plain past tense prose, name people explicitly, and reply with the summary text only.`;

export const defaultSettings = Object.freeze({
    enabled: true,

    // What gets built
    factsEnabled: true,
    spineEnabled: true,
    perception: false,

    // When extraction runs
    autoExtract: true,
    interval: 12,
    buffer: 2,
    maxBatch: 24,

    // Context trimming
    ghosting: true,
    verbatimTurns: 12,

    // Injection
    depth: 4,
    role: 0,
    budgetTokens: 1200,
    spineShare: 0.4,
    injectionHeader: 'Story memory. Established facts and what has happened so far. Treat it as true.',

    // Store limits
    maxFacts: 400,
    maxFactsPerEntity: 12,
    snippetsPerLayer: 24,
    snippetsPerPromotion: 4,
    maxLayers: 4,

    // Model
    profileId: '',
    maxResponseTokens: 1200,

    // Prompts
    systemPrompt: EXTRACT_SYSTEM_PROMPT,
    userPrompt: EXTRACT_USER_PROMPT,
    consolidatePrompt: CONSOLIDATE_PROMPT,
    promotePrompt: PROMOTE_PROMPT,

    // Chrome
    notify: true,
    useJsonSchema: true,
});

export function getSettings() {
    const all = ctx().extensionSettings;
    if (!all[MODULE]) {
        all[MODULE] = structuredClone(defaultSettings);
    }
    for (const [k, v] of Object.entries(defaultSettings)) {
        if (all[MODULE][k] === undefined) all[MODULE][k] = v;
    }
    return all[MODULE];
}

export function saveSettings() {
    ctx().saveSettingsDebounced();
}
