/** One beads issue, trimmed to the fields the pane draws. */
export type Issue = {
    /** Issue id with its prefix, as `bp-3tk.2`. */
    id: string;
    /** One-line title. */
    title: string;
    /** Workflow status, as `open`, `in_progress`, `blocked` or `closed`. */
    status: string;
    /** Priority from 0 (critical) to 4 (backlog). */
    priority: number;
    /** Issue type, as `task`, `bug`, `feature` or `epic`. */
    issue_type: string;
};

/**
 * Which issues the pane lists, each read by its own bd command.
 * `ready` has no open blockers, `blocked` waits on another issue, `open` is everything neither closed nor deferred, `all` includes both.
 */
export type Filter = "ready" | "blocked" | "open" | "all";

/**
 * What the pane knows of the session's beads database.
 * `idle` holds until the first load, `missing` means bd found no database for the session's working directory.
 */
export type Load =
    | { kind: "idle" }
    | { kind: "missing" }
    | { kind: "error"; message: string }
    | { kind: "ready"; filter: Filter; issues: Issue[] };

declare module "claude-code" {
    interface PluginState {
        "beads-pane": { load: Shaped<Load>; filter: Shaped<Filter> };
    }
}
