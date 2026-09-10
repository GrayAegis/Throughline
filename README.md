# Throughline

Story-scoped memory for SillyTavern. It records what is true in your story, keeps it in the chat file itself, and every branch you create inherits it automatically.

No lorebooks. No Data Bank files. Nothing to name, bind, order, or budget across books.

## What it records

Two tracks, filled by a single extraction pass over each new passage.

**Facts** are the primary store. Each one is a durable statement with a validity range: the message where it became true, and the message where it stopped. Nothing is overwritten, so a fact that ends is closed rather than erased, and the store can still answer what was true earlier. Facts carry a category, the entities they are about, and optionally who knows them.

**The spine** is a compressed narrative of what happened, in layers. Recent summaries sit in layer zero; when a layer fills, its oldest entries are folded into one summary on the layer above. It can be turned off entirely if you would rather run on facts plus a verbatim window.

## Why the chat file

SillyTavern builds a new branch's header by spreading the parent's chat metadata and overriding only the parent pointer. Anything an extension stores there is inherited by every branch and checkpoint, then diverges independently from the fork onward.

That gives the behavior a branch-heavy workflow actually wants, with no lineage plumbing:

- A branch starts with everything the trunk knew.
- Facts written after the fork stay in the branch that wrote them.
- A branch cut at an earlier message drops facts anchored past that point, because that future never happened here.
- A fifty deep chain of branches carries its memory forward the whole way.

The panel labels which records were inherited and which were written in the current branch.

## Installing

Clone into your SillyTavern user extensions directory, then reload the page.

```bash
git clone https://github.com/GrayAegis/Throughline.git "SillyTavern/data/<your-user>/extensions/Throughline"
```

Requires SillyTavern 1.18.0 or newer.

## Using it

Extraction runs automatically once enough new messages have accumulated, holding back the most recent few so the live tail is never summarized out from under you. You can also run it by hand from the settings panel, from a message, or with a slash command.

Once a passage is remembered, the messages behind it are hidden from the prompt, leaving a verbatim window of recent turns. Messages Throughline hides are flagged as its own, so anything you hid by hand is never quietly restored, and vice versa.

At generation time the store is composed into one block injected in chat at a depth you choose, inside a single token budget. Facts are ranked by pinned status, whether their entities are in the current scene, and how recently they became true. When the budget runs out, the lowest ranked are dropped rather than the block overflowing.

### The panel

Open it from the extension settings or with `/tl-panel`.

- **Facts** lists everything recorded, with filtering, pinning, editing, retiring, and deletion. Entity chips show which subjects have the most facts; clicking one merges that entity's facts back under its cap.
- **Spine** shows the summary layers.
- **What gets injected** renders the exact text the model will see, with its token count and how many facts were dropped for budget.

### Commands

| Command | Effect |
|---|---|
| `/tl-extract` | Run an extraction over everything not yet remembered |
| `/tl-panel` | Open the memory panel |
| `/tl-note <text>` | Record a fact by hand, pinned so extraction never retires it |
| `/tl-preview` | Return the memory block currently being injected |

The `{{throughline}}` macro returns the same block, if you would rather place it yourself in a prompt template.

## Settings worth knowing

- **Connection profile** runs memory work on a separate, cheaper model. Left empty it uses your live connection.
- **Perception** records who knows each fact and injects only what the characters in the scene could know. Off by default.
- **Facts per entity** is the merge threshold. When one subject accumulates more than this, its facts are consolidated automatically.
- **Token budget** and **share given to the spine** divide the injected block. Setting the share to zero with the spine enabled is the same as disabling it.

## Limits

The store rides in the first line of the chat file and is copied into every branch, so it is capped on purpose. When facts run over the cap, the oldest closed ones are dropped. Pinned facts are never dropped, never retired by extraction, and never merged.

There is no merge between sibling branches. Memory flows forward from a fork, never sideways or back. Export and import exist for moving a store deliberately.

## Credit

The layered spine and the flag-your-own-hidden-messages approach are both lifted from [Summaryception](https://github.com/Lodactio/Extension-Summaryception). The idea of discrete categorized facts rather than prose summaries comes from [ThreadKeeper](https://github.com/selinawynters-ops/ST---ThreadKeeper). Perception scoping is [charSummaryception](https://github.com/Beuli97/charSummaryception)'s idea, reduced here to a field on each fact instead of a memory file per character.
