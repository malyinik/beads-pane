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
 * `ready` has no open blockers, `blocked` waits on another issue, `open` is everything neither closed nor deferred, `closed` is what was closed, `all` includes everything.
 */
export type Filter = "ready" | "blocked" | "open" | "closed" | "all";

/**
 * What one read of the session's beads database came to.
 * `missing` means bd found no database for the session's working directory.
 */
export type Load =
    | { kind: "missing" }
    | { kind: "error"; message: string }
    | { kind: "ready"; issues: Issue[] };

/** The last {@link Load} of each {@link Filter}; a filter never read yet has none. */
export type Lists = Partial<Record<Filter, Load>>;

declare module "claude-code" {
    interface PluginState {
        "beads-pane": { lists: Shaped<Lists>; filter: Shaped<Filter> };
    }
}
