# beads-pane

A Claude Code plugin that shows [beads](https://github.com/steveyegge/beads) (`bd`) issues in a side pane next to the chat.

The main target is the Claude Code desktop app (`desktop` surface).
The terminal (`terminal` surface) runs the same code.

> **Status:** early development.
> The `/beads-pane` command opens the pane and lists issues, filtered by `ready`, `blocked`, `open`, `closed` or `all`.
> Each filter button counts its issues, and the issues in progress stay pinned atop the pane whatever the filter.
> An open epic's row shows how many of its children are closed, as `(7/10)` before its title.
> An epic ready to close, every child of it closed, is marked with a green `◉`.
> The issues of an epic stand under it in the list, tied to it by tree lines.
> Pressing an issue's title opens its card: description, notes, linked issues and comments.
> The card's `Ask the agent to take this issue…` button drafts a request to the agent, in the prompt box, to claim the issue and read it.
> Its `Ask the agent to close this issue…` button drafts a request to check that the issue's work is done and close it.
> The `Ask the agent to pick the next issue…` button drafts a request to pick the ready issue that fits the session's work best and take it.
> While the pane is open, it is read again on its `Refresh` button, and after each agent turn or `bd` command the agent runs when the beads database changed.

## Requirements

| What        | Version                                                      |
| ----------- | ------------------------------------------------------------ |
| Claude Code | a build with plugin hooks modules, developed against 2.1.312 |
| `bd`        | 1.2 or later, on `PATH`                                      |

The pane reads the beads database of the session's working directory.

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install beads-pane --marketplace malyinik/beads-pane
```

From a shell:

```bash
claude plugin install beads-pane --marketplace malyinik/beads-pane
```

In the desktop app, where `/plugin` does not run:

1. Click **+** next to the prompt box, then **Plugins**.
2. Choose **Add marketplace** and enter `malyinik/beads-pane`.
3. Choose **Add plugin**.

## Usage

| Command       | What it does         |
| ------------- | -------------------- |
| `/beads-pane` | Opens the beads pane |

## Development

Load the plugin from a working copy for one session:

```bash
claude --plugin-dir ~/beads-pane
```

An interactive session reloads the hooks module when its files change.
The desktop app reads the same folder from `CLAUDE_CODE_PLUGIN_DIRS` in the `env` block of `~/.claude/settings.json`.

Check the manifest and the hooks module:

```bash
claude plugin validate ~/beads-pane
```

Run the tests in `tests/`:

```bash
claude plugin test ~/beads-pane
```

Type-check, once the plugin has loaded and Claude Code has written its types to `.claude-plugin/types/`:

```bash
npx -p typescript tsc -p ~/beads-pane
```

## License

[MIT](LICENSE)
