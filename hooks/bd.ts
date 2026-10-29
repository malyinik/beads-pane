import type { EngineInterface, ProcessRunResult } from "claude-code";

import type {
    Card,
    CardLoad,
    Comment,
    Issue,
    Listing,
    Load,
    Progresses,
} from "../types";

/** The bd command that reads each {@link Listing}, with no limit on the number of issues. */
const COMMANDS: Record<Listing, readonly string[]> = {
    ready: ["bd", "ready", "--json", "--limit", "0"],
    blocked: ["bd", "blocked", "--json"],
    open: [
        "bd",
        "list",
        "--json",
        "--limit",
        "0",
        "--status",
        "open,in_progress,blocked",
    ],
    deferred: ["bd", "list", "--json", "--limit", "0", "--status", "deferred"],
    closed: ["bd", "list", "--json", "--limit", "0", "--status", "closed"],
    all: ["bd", "list", "--all", "--json", "--limit", "0"],
    in_progress: [
        "bd",
        "list",
        "--json",
        "--limit",
        "0",
        "--status",
        "in_progress",
    ],
};

/** `bd where`, which names the workspace bd resolves for the working directory. */
const WHERE = ["bd", "where", "--json"] as const;

/** The `error` code `bd where --json` reports when no beads database is found. */
const NO_DATABASE = "no_beads_directory";

/**
 * Runs the bd command of `listing` in the session's working directory and turns its outcome into a {@link Load}.
 * The issues come in the listing's order from {@link ORDERS}.
 * Never rejects: a bd that fails or cannot start comes back as an `error` load.
 */
export async function fetchLoad(
    $: EngineInterface,
    listing: Listing,
): Promise<Load> {
    const run = await runBd($, COMMANDS[listing]);
    if (run.kind !== "ran") {
        return run;
    }
    const issues = parseIssues(run.stdout);

    return issues === undefined
        ? {
              kind: "error",
              message: "bd printed something other than a JSON list of issues.",
          }
        : { kind: "ready", issues: issues.sort(ORDERS[listing]) };
}

/**
 * Reads the card of issue `id` with one `bd show`, its dependents and comments included.
 * Never rejects: a bd that fails, cannot start or finds no such issue comes back as an `error` load.
 */
export async function fetchCard(
    $: EngineInterface,
    id: string,
): Promise<CardLoad> {
    const run = await runBd($, [
        "bd",
        "show",
        id,
        "--json",
        "--include-dependents",
        "--include-comments",
    ]);
    if (run.kind === "missing") {
        return { kind: "error", message: "No beads database for this folder." };
    }
    if (run.kind === "error") {
        return run;
    }
    const card = parseCard(run.stdout);

    return card === undefined
        ? {
              kind: "error",
              message: "bd printed something other than a JSON issue.",
          }
        : { kind: "ready", card };
}

/** `bd epic status`, which counts the children of every open epic and leaves out an epic without children. */
const EPICS = ["bd", "epic", "status", "--json"] as const;

/**
 * Reads how far every open epic has come with one `bd epic status`.
 * `undefined` when bd fails, cannot start or prints something other than a list of epics.
 * Never rejects.
 */
export async function fetchProgress(
    $: EngineInterface,
): Promise<Progresses | undefined> {
    const run = await $.process.run(EPICS).catch(() => undefined);
    const value = run?.exitCode === 0 ? parseJson(run.stdout) : undefined;
    if (!Array.isArray(value)) {
        return undefined;
    }
    const progress: Progresses = {};
    for (const entry of value) {
        if (
            !isRecord(entry) ||
            !isRecord(entry.epic) ||
            typeof entry.epic.id !== "string" ||
            typeof entry.closed_children !== "number" ||
            typeof entry.total_children !== "number"
        ) {
            return undefined;
        }
        progress[entry.epic.id] = {
            closed: entry.closed_children,
            total: entry.total_children,
            isDone: entry.eligible_for_close === true,
        };
    }

    return progress;
}

/**
 * The version of the embedded Dolt database bd reads: the text of its `manifest`, which every write to the database changes and a read leaves alone.
 * `undefined` when it cannot be told, as with no database, a Dolt server in place of the embedded database, or files laid out otherwise.
 * Never rejects.
 */
export async function fetchVersion(
    $: EngineInterface,
): Promise<string | undefined> {
    const manifest = await locateManifest($);

    return manifest === undefined
        ? undefined
        : await $.fs.read(manifest).catch(() => undefined);
}

/** Where {@link locateManifest} last found the `manifest`, and the working directory it was asked from. */
let located: { cwd: string; manifest: string } | undefined;

/**
 * The path of the `manifest` of the embedded database `bd where` names for the working directory, or `undefined` when there is none.
 * A path found is kept for that directory, so later calls run no bd.
 */
async function locateManifest($: EngineInterface): Promise<string | undefined> {
    const cwd = await $.session.cwd();
    if (located?.cwd === cwd) {
        return located.manifest;
    }
    const where = await $.process.run(WHERE).catch(() => undefined);
    const workspace =
        where?.exitCode === 0 ? recordOf(where.stdout) : undefined;
    if (
        typeof workspace?.path !== "string" ||
        typeof workspace.database_path !== "string"
    ) {
        return undefined;
    }
    const metadata = recordOf(
        await $.fs.read(`${workspace.path}/metadata.json`).catch(() => ""),
    );
    if (
        metadata?.dolt_mode !== "embedded" ||
        typeof metadata.dolt_database !== "string"
    ) {
        return undefined;
    }
    const manifest = `${workspace.database_path}/${metadata.dolt_database}/.dolt/noms/manifest`;
    located = { cwd, manifest };

    return manifest;
}

/** A bd run that printed its JSON, or the failure it came to. */
type Run =
    | { kind: "ran"; stdout: string }
    | { kind: "missing" }
    | { kind: "error"; message: string };

/**
 * Runs `argv` in the session's working directory.
 * Never rejects: a bd that cannot start or exits with an error comes back as `missing` or `error`.
 */
async function runBd(
    $: EngineInterface,
    argv: readonly string[],
): Promise<Run> {
    let ran: ProcessRunResult;
    try {
        ran = await $.process.run(argv);
    } catch (error) {
        return {
            kind: "error",
            message: `Could not run bd: ${reasonOf(error)}`,
        };
    }

    return ran.exitCode === 0
        ? { kind: "ran", stdout: ran.stdout }
        : await explainFailure($, ran);
}

/**
 * Tells a missing database from any other failure of a bd listing.
 * The listings report a missing database only as text on stderr, so the check asks `bd where`, which reports it as a JSON error code.
 */
async function explainFailure(
    $: EngineInterface,
    listed: ProcessRunResult,
): Promise<Exclude<Run, { kind: "ran" }>> {
    const where = await $.process.run(WHERE).catch(() => undefined);
    if (where !== undefined && recordOf(where.stdout)?.error === NO_DATABASE) {
        return { kind: "missing" };
    }

    return { kind: "error", message: failureText(listed) };
}

/**
 * The message of a failed bd run: the `message` of a JSON error on stdout, else the first line of stderr without its `Error:` prefix.
 * Falls back to the exit code when bd printed neither.
 */
function failureText(ran: ProcessRunResult): string {
    const message = recordOf(ran.stdout)?.message;
    if (typeof message === "string" && message !== "") {
        return message;
    }
    const line =
        ran.stderr
            .trim()
            .split("\n")[0]
            ?.replace(/^Error:\s*/, "") ?? "";

    return line !== "" ? line : `bd exited with code ${ran.exitCode}.`;
}

/** The JSON object in `text`, or `undefined` when the text is not one. */
function recordOf(text: string): Record<string, unknown> | undefined {
    const value = parseJson(text);

    return isRecord(value) ? value : undefined;
}

/**
 * The issues of a `bd list --json` output, trimmed to {@link Issue}.
 * Returns `undefined` when the text is not a JSON array or an entry lacks a string `id` or `title`.
 */
function parseIssues(text: string): Issue[] | undefined {
    const value = parseJson(text);
    if (!Array.isArray(value)) {
        return undefined;
    }
    const issues: Issue[] = [];
    for (const entry of value) {
        const issue = issueOf(entry);
        if (issue === undefined) {
            return undefined;
        }
        issues.push(issue);
    }

    return issues;
}

/** One issue of bd's JSON trimmed to {@link Issue}, or `undefined` when it lacks a string `id` or `title`. */
function issueOf(entry: unknown): Issue | undefined {
    if (
        !isRecord(entry) ||
        typeof entry.id !== "string" ||
        typeof entry.title !== "string"
    ) {
        return undefined;
    }

    return {
        id: entry.id,
        title: clean(entry.title),
        status: typeof entry.status === "string" ? entry.status : "",
        priority: typeof entry.priority === "number" ? entry.priority : 2,
        issue_type:
            typeof entry.issue_type === "string" ? entry.issue_type : "",
        ...(typeof entry.closed_at === "string"
            ? { closed_at: entry.closed_at }
            : {}),
        ...(typeof entry.parent === "string" ? { parent: entry.parent } : {}),
    };
}

/**
 * The card of a `bd show --json` output: the first issue of the array, its links grouped by the side they come from and their `dependency_type`.
 * bd lists a `relates-to` link among both the dependencies and the dependents, so related issues are kept once each.
 * Returns `undefined` when the text is not a JSON array that starts with an issue.
 */
function parseCard(text: string): Card | undefined {
    const value = parseJson(text);
    const entry = Array.isArray(value) ? value[0] : undefined;
    if (!isRecord(entry) || issueOf(entry) === undefined) {
        return undefined;
    }
    const dependencies = linksOf(entry.dependencies);
    const dependents = linksOf(entry.dependents);
    const related = [...dependencies, ...dependents].filter((link) =>
        RELATED.has(link.type),
    );

    return {
        description: textOf(entry.description),
        design: textOf(entry.design),
        acceptance_criteria: textOf(entry.acceptance_criteria),
        notes: textOf(entry.notes),
        owner: textOf(entry.created_by) || textOf(entry.owner),
        assignee: textOf(entry.assignee),
        labels: Array.isArray(entry.labels)
            ? entry.labels.filter((label) => typeof label === "string")
            : [],
        created_at: textOf(entry.created_at),
        updated_at: textOf(entry.updated_at),
        close_reason: textOf(entry.close_reason),
        parent: ofType(dependencies, "parent-child"),
        depends_on: ofType(dependencies, "blocks"),
        blocks: ofType(dependents, "blocks"),
        children: ofType(dependents, "parent-child"),
        related: related
            .filter(
                (link, index) =>
                    related.findIndex(
                        (one) => one.issue.id === link.issue.id,
                    ) === index,
            )
            .map((link) => link.issue)
            .sort(byPriority),
        comments: Array.isArray(entry.comments)
            ? entry.comments.flatMap(commentOf)
            : [],
    };
}

/** The `dependency_type` values bd gives a link that blocks neither issue. */
const RELATED: ReadonlySet<string> = new Set(["relates-to", "related"]);

/** An issue linked to the card's issue, with the `dependency_type` of the link. */
type Link = { issue: Issue; type: string };

/** The links of a `dependencies` or `dependents` list; entries that are not issues are left out. */
function linksOf(value: unknown): Link[] {
    return Array.isArray(value)
        ? value.flatMap((entry) => {
              const issue = issueOf(entry);

              return issue === undefined || !isRecord(entry)
                  ? []
                  : [{ issue, type: textOf(entry.dependency_type) }];
          })
        : [];
}

/** The issues of `links` whose link is of `type`, by priority. */
function ofType(links: readonly Link[], type: string): Issue[] {
    return links
        .filter((link) => link.type === type)
        .map((link) => link.issue)
        .sort(byPriority);
}

/** One comment of bd's JSON, as a list of one, or none when it has no string `text`. */
function commentOf(entry: unknown): Comment[] {
    return isRecord(entry) && typeof entry.text === "string"
        ? [
              {
                  author: textOf(entry.author),
                  text: clean(entry.text),
                  created_at: textOf(entry.created_at),
              },
          ]
        : [];
}

/** A string field of bd's JSON without control characters, or an empty string when the field is absent or not a string. */
function textOf(value: unknown): string {
    return typeof value === "string" ? clean(value) : "";
}

/**
 * `text` without the control characters a drawing refuses; tab and newline stay.
 * A description pasted with Windows line ends carries carriage returns, and one such character would leave the whole pane undrawn.
 */
function clean(text: string): string {
    return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, "");
}

/** Orders closed issues by when they were closed, the latest first, then as {@link byPriority} does. */
function byClosing(a: Issue, b: Issue): number {
    return (
        (b.closed_at ?? "").localeCompare(a.closed_at ?? "") || byPriority(a, b)
    );
}

/** Orders issues by priority, the most urgent first, then by id with numeric parts compared as numbers. */
function byPriority(a: Issue, b: Issue): number {
    return (
        a.priority - b.priority ||
        a.id.localeCompare(b.id, "en", { numeric: true })
    );
}

/** How each {@link Listing} orders its issues: closed ones by closing, the rest by priority. */
const ORDERS: Record<Listing, (a: Issue, b: Issue) => number> = {
    ready: byPriority,
    blocked: byPriority,
    open: byPriority,
    deferred: byPriority,
    closed: byClosing,
    all: byPriority,
    in_progress: byPriority,
};

/** `JSON.parse` that returns `undefined` instead of throwing. */
function parseJson(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

/** Whether a parsed JSON value is an object other than an array. */
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The text of a rejection, whatever was thrown. */
function reasonOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
