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

This list is the map of what the plugin does today, and it must match the code.
Any change that adds, changes or removes behaviour updates this list in the same commit: a new item for a new feature, an edited item for a changed one, a deleted item for a removed one.
Before reporting such a change as done, check the list against the code it touched.

- `/beads-pane` opens the pane; nothing opens it at session start.
- Loading
  - Each run of the command reads the chosen filter, then the other filters one by one in the background.
  - Every filter keeps its last read in `beads-pane.lists`, so a switch draws at once while bd reads that filter again.
  - While the pane is open, everything it draws is read again on the `Refresh` button (hotkey `u`), and at the end of each main-loop turn and after each Bash command that runs `bd` anywhere in it (`cd repo && bd close x` too) when the database version changed.
  - The database version is the text of the embedded database's `manifest`, found through `bd where` and `metadata.json` once per working directory; when it cannot be read, as with a Dolt server, those triggers always read.
  - Such a reload reads the chosen filter, then the others, then the open card; one asked for while another runs makes that one read once more instead of starting a second.
  - The pane draws four states besides the list: not loaded yet, loading, no beads database (with a `bd init` hint) and a bd error.
- Filters
  - Buttons `Ready`, `Blocked`, `Open`, `Closed` and `All`, with the hotkeys `r`, `b`, `o`, `c` and `a`.
  - The choice is kept in `beads-pane.filter`; `Open` is the default.
  - `Open` leaves out deferred and closed issues.
  - `Closed` is ordered by `closed_at`, latest first; the other filters by priority, then by id.
  - The row ends with `Refresh` (see Loading).
- Under the filters, on a line of its own, `Ask the agent to pick the next issue…` (hotkey `n`) drafts in the prompt box, as the card's `Ask the agent to take this issue…` does, the request to pick of the issues `bd ready` lists the one that fits best with the session's work, say which and why, then claim it and read it. The agent picks, since only it knows the session.
- Rows
  - Columns: status mark, priority, id, type, title. Each column has one width, and a wrapped title stays in its column.
  - Status marks are bd's own; an open issue that `bd blocked` lists gets the blocked mark `●`.
  - Marks take bd's colors, `#FFB454` (in progress), `#F07178` (blocked) and `#8090A0` (closed), with open plain; the deferred mark is ice blue `#39BAE6` instead of bd's gray, so it does not read as closed.
  - Priorities take bd's colors: P0 `#F07178` in bold, P1 `#FF8F40`, P2 `#E6B450`, P3 and P4 plain.
  - Types take `#D2A6FF` (epic), `#59C2FF` (feature), `#F26D78` (bug), `#95E6CB` (task) and `#A6ACB3` (any other).
  - Closed issues are drawn dim.
  - Pressing an id copies it, and a toast says whether the copy took.
  - Pressing a title opens the issue's card under its row; pressing it again closes the card. One card is open at a time.
- Card
  - Read with one `bd show <id> --json --include-dependents --include-comments` each time it opens; the last read is kept in `beads-pane.cards` and drawn meanwhile, the open id in `beads-pane.expanded`.
  - A facts line: status, owner (the `created_by` actor, as `bd show` prints it), assignee, labels, created and updated days, closing day and reason.
  - Under the facts line of an issue that is not closed, a `Ask the agent to take this issue…` button (hotkey `s`) drafts a prompt in the prompt box through `$.prompt.fill`, for the person to edit and send: the id and title, and the request to claim the issue with `bd update <id> --claim` and read it with `bd show <id>`.
  - An empty prompt box takes the draft whole; one holding text keeps it, with the draft after a blank line. A toast says whether the box took the draft.
  - Markdown sections `Description`, `Design`, `Acceptance criteria` and `Notes`, each only when bd has text for it.
  - Linked issues in the columns of a list row (status mark and priority, id, title), with one id width across the card, grouped as `Parent`, `Depends on`, `Blocks`, `Children` and `Related`; a group without issues is left out.
  - `Children` carries the epic's progress as bd prints it, `3/10 complete (30%)`.
  - The card has a `subtle` rounded border and, outside the terminal, a translucent gray background `#8080801A`.
  - `Comments`, oldest first, each with its author and day.
  - Control characters other than tab and newline are stripped from bd's text, so a pasted carriage return cannot leave the pane undrawn.
  - A failed read draws `bd failed:` with bd's message inside the card.
