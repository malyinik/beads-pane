# beads-pane

A Claude Code plugin (a hooks-module mod) that shows beads (`bd`) issues in a side pane.
The main target is the desktop app (`desktop` surface); the terminal runs the same code.
It is developed against Claude Code 2.1.312 and bd 1.2.2.

## Layout

| Path                      | What it holds                                                                                     |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| `hooks/register.tsx`      | The `/beads-pane` command, the state atoms and the `Pane` drawing                                 |
| `hooks/bd.ts`             | Running bd and turning its JSON into a `Load`                                                     |
| `types/index.d.ts`        | The state contract (`PluginState["beads-pane"]`) and the shared types                             |
| `tests/register.test.tsx` | Tests on `claude-code/testing`                                                                    |
| `.claude-plugin/`         | `plugin.json` and `marketplace.json`; `types/` inside it is written by the engine and git-ignored |

## Checks

Run all three before reporting a change as done:

```bash
claude plugin validate .
claude plugin test .
npx -y -p typescript@5.6.3 tsc -p .
```

`tsc` needs `.claude-plugin/types/`, which the engine writes once the plugin has loaded in a signed-in session.

## Engine quirks

- The validator's scan accepts `read`, `update` and `atom` only when the atom is a `const` of the same file.
- `$.state` outlives a reload: bump an atom's `shape` tag whenever the type of its stored value changes.
- A render hook never writes state; writes come from handlers and other events.
- The desktop draws a Button's `label` in place of its children, so a Button that shows its own children takes no `label`.
- A `Space` number is whole cells on every surface. A step (`xs`, `sm`, ...) is sized by each surface, and the terminal draws `xs` and `sm` down as zero rows.
- In tests, `$.command.run` does not wait for work the command left running; the `engine()` helper returns `settle`, backed by `mock.clock`.
- In tests, `on(event)` takes one hook per event, so the `engine()` helper answers `process.run` for every bd subcommand, `ui.panes` from the panes it opened, `turn.complete`, `session.cwd`, `fs.read`, `prompt.read` and `prompt.fill`.
- In tests, `turn.complete` and `prompt.fill` are answered with their own results, `{ text }` and `{ isFilled }`, while `ui.open`, `ui.panes` and `prompt.read` take `{ value }`.
- In tests, a `prompt.fill` refusal carries no `refusal` cause: the engine strips the cause a hook writes itself.

## bd quirks

- Concurrent bd runs on the embedded Dolt database are slower than serial ones, so the pane reads filters one after another.
- bd keeps a dependency-blocked issue's `status` as `open`; only `bd blocked` says it is blocked.
- `bd list` stops at 50 issues and `bd ready` at 100 unless given `--limit 0`.
- Without a database, `bd list` writes only text to stderr, while `bd where --json` reports `"error": "no_beads_directory"`.
- `bd history <id> --json` fails on bd 1.2.2.
- `bd show --json` prints an array of one issue; with `--include-dependents` and `--include-comments` it carries `dependents` and `comments`, and leaves `comments` out when there are none.
- `bd show` prints as `Owner` the `created_by` actor (git `user.name`), while the JSON `owner` is git `user.email`.
- A `relates-to` link appears in both `dependencies` and `dependents`.
- The entries of `dependents` carry zero dates (`0001-01-01T00:00:00Z`).
- The embedded database's `.dolt/noms/manifest` changes its text on every write, while reads move only its modification time.

## Implemented

This list is the map of what the plugin does today, as the person using it sees it, and it must match the code.
It names features, not how they are built: bd commands, state keys, colors and read order are left to the code.
Any change that adds, changes or removes behaviour updates this list in the same commit: a new item for a new feature, an edited item for a changed one, a deleted item for a removed one.
Before reporting such a change as done, check the list against the code it touched.

- `/beads-pane` opens the pane; nothing opens it at session start.
- `In progress`, atop the pane, keeps the issues in progress in view whatever the filter, and is left out while there are none.
- Filters
  - Buttons `Ready`, `Blocked`, `Open`, `Deferred`, `Closed` and `All`, with the hotkeys `r`, `b`, `o`, `d`, `c` and `a`; `Open` is the default, and the choice outlives a reload of the plugin.
  - `Open` leaves out deferred and closed issues, and `Deferred` lists only the deferred ones.
  - Each button shows how many issues its filter holds, as `Ready 7`, once that filter has been read.
  - A switch draws the filter's last read at once while it is read again.
  - The row ends with `Refresh` (hotkey `u`).
- `Ask the agent to pick the next issue…` (hotkey `n`), under the filters, drafts in the prompt box a request to pick of the ready issues the one that fits the session's work best, say which and why, then take it.
- List
  - Rows in columns: status mark, priority, id, type, title; a long title wraps within its column.
  - `Closed` lists the latest closed first; the other filters go by priority, then by id.
  - Status marks, priorities and types are colored after bd; an open issue blocked by another gets the blocked mark; closed issues are dim.
  - An open epic whose children are all closed takes a green `◉` in place of its mark, as ready to close.
  - An open epic with children leads its title, in the list and in `In progress`, with its closed children of all, as `(7/10)`.
  - The issues of an epic stand under it one step right, tied to it by dim tree lines, in the filter's order. An epic the filter leaves out is drawn dim above its issues, and `In progress` is not grouped.
  - Pressing an id copies it; pressing a title opens the issue's card under its row, and pressing it again closes it. One card is open at a time.
- Card
  - A facts line: status, owner, assignee, labels, created and updated days, closing day and reason.
  - `Ask the agent to take this issue…` (hotkey `s`), on an issue that is not closed, drafts in the prompt box a request to claim the issue and read it.
  - `Ask the agent to close this issue…` (hotkey `x`), on an issue that is not closed, drafts in the prompt box a request to check that the issue's work is done, then close it with a reason; the pane itself never changes an issue.
  - The sections `Description`, `Design`, `Acceptance criteria` and `Notes`, each only when it has text.
  - Linked issues grouped as `Parent`, `Depends on`, `Blocks`, `Children` and `Related`; `Children` carries the epic's progress, as `3/10 complete (30%)`.
  - `Comments`, oldest first, each with its author and day.
  - An issue in `In progress` opens its card there, never a second time in the list.
- Drafts
  - Both draft buttons leave the request in the prompt box for the person to edit and send; text already there is kept, with the draft after a blank line.
  - A toast says whether the box took the draft.
- Staying current
  - While the pane is open, it reads bd again on `Refresh`, and after each agent turn or Bash command that runs `bd` when the beads database changed.
- Besides the list, the pane draws: not loaded yet, loading, no beads database (with a `bd init` hint) and a bd error; a card that cannot be read says why.
