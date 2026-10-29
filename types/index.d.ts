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
    /** When the issue was closed, as an ISO 8601 UTC time; absent while it is not closed. */
    closed_at?: string;
};

/**
 * Which issues the pane lists, each read by its own bd command.
 * `ready` has no open blockers, `blocked` waits on another issue, `open` is everything neither closed nor deferred, `closed` is what was closed, `all` includes everything.
 */
export type Filter = "ready" | "blocked" | "open" | "closed" | "all";

/** What one bd listing reads: a {@link Filter}'s issues, or `in_progress`, the issues in progress the pane keeps in view above every filter. */
export type Listing = Filter | "in_progress";

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

/** One comment on an issue. */
export type Comment = {
    /** Who wrote it. */
    author: string;
    /** The comment's markdown. */
    text: string;
    /** When it was written, as an ISO 8601 UTC time. */
    created_at: string;
};

/**
 * What the card of one issue shows beyond its row: the texts, the people and dates, and the issues linked to it.
 * A text bd leaves empty is an empty string, and a link group without issues is an empty list.
 */
export type Card = {
    /** The issue's description, in markdown. */
    description: string;
    /** The issue's design notes, in markdown. */
    design: string;
    /** The issue's acceptance criteria, in markdown. */
    acceptance_criteria: string;
    /** The issue's notes, in markdown. */
    notes: string;
    /**
     * Who owns the issue, as `bd show` prints it: the `created_by` actor, else the `owner` email.
     * Empty when bd records neither.
     */
    owner: string;
    /** Who the issue is assigned to; empty while nobody is. */
    assignee: string;
    /** The issue's labels, in bd's order. */
    labels: string[];
    /** When the issue was created, as an ISO 8601 UTC time. */
    created_at: string;
    /** When the issue last changed, as an ISO 8601 UTC time. */
    updated_at: string;
    /** Why the issue was closed; empty while it is open. */
    close_reason: string;
    /** The epic the issue belongs to. */
    parent: Issue[];
    /** The issues that block this one. */
    depends_on: Issue[];
    /** The issues this one blocks. */
    blocks: Issue[];
    /** The issues that belong to this one, when it is an epic. */
    children: Issue[];
    /** The issues linked to this one without blocking either way. */
    related: Issue[];
    /** The comments, oldest first. */
    comments: Comment[];
};

/** What one read of an issue's card came to. */
export type CardLoad =
    | { kind: "error"; message: string }
    | { kind: "ready"; card: Card };

/** The last {@link CardLoad} of each issue whose card was opened, by issue id. */
export type Cards = Record<string, CardLoad>;

declare module "claude-code" {
    interface PluginState {
        "beads-pane": {
            lists: Shaped<Lists>;
            filter: Shaped<Filter>;
            expanded: Shaped<string | null>;
            cards: Shaped<Cards>;
            working: Shaped<Load | null>;
        };
    }
}
