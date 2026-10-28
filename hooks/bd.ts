import type { EngineInterface, ProcessRunResult } from "claude-code";

import type { Filter, Issue, Load } from "../types";

/** The bd command that lists each {@link Filter}'s issues, with no limit on their number. */
const COMMANDS: Record<Filter, readonly string[]> = {
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
    closed: ["bd", "list", "--json", "--limit", "0", "--status", "closed"],
    all: ["bd", "list", "--all", "--json", "--limit", "0"],
};

/** `bd where`, which names the workspace bd resolves for the working directory. */
const WHERE = ["bd", "where", "--json"] as const;

/** The `error` code `bd where --json` reports when no beads database is found. */
const NO_DATABASE = "no_beads_directory";

/**
 * Runs the bd command of `filter` in the session's working directory and turns its outcome into a {@link Load}.
 * The issues come in the filter's order from {@link ORDERS}.
 * Never rejects: a bd that fails or cannot start comes back as an `error` load.
 */
export async function fetchLoad(
    $: EngineInterface,
    filter: Filter,
): Promise<Load> {
    let listed: ProcessRunResult;
    try {
        listed = await $.process.run(COMMANDS[filter]);
    } catch (error) {
        return {
            kind: "error",
            message: `Could not run bd: ${reasonOf(error)}`,
        };
    }
    if (listed.exitCode !== 0) {
        return await explainFailure($, listed);
    }
    const issues = parseIssues(listed.stdout);

    return issues === undefined
        ? {
              kind: "error",
              message: "bd printed something other than a JSON list of issues.",
          }
        : { kind: "ready", issues: issues.sort(ORDERS[filter]) };
}

/**
 * Tells a missing database from any other failure of a bd listing.
 * The listings report a missing database only as text on stderr, so the check asks `bd where`, which reports it as a JSON error code.
 */
async function explainFailure(
    $: EngineInterface,
    listed: ProcessRunResult,
): Promise<Load> {
    const where = await $.process.run(WHERE).catch(() => undefined);
    if (where !== undefined && errorOf(where.stdout)?.error === NO_DATABASE) {
        return { kind: "missing" };
    }

    return { kind: "error", message: failureText(listed) };
}

/**
 * The message of a failed bd run: the `message` of a JSON error on stdout, else the first line of stderr without its `Error:` prefix.
 * Falls back to the exit code when bd printed neither.
 */
function failureText(ran: ProcessRunResult): string {
    const message = errorOf(ran.stdout)?.message;
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

/** The JSON error object bd printed, or `undefined` when the text is not one. */
function errorOf(text: string): Record<string, unknown> | undefined {
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
        if (
            !isRecord(entry) ||
            typeof entry.id !== "string" ||
            typeof entry.title !== "string"
        ) {
            return undefined;
        }
        issues.push({
            id: entry.id,
            title: entry.title,
            status: typeof entry.status === "string" ? entry.status : "",
            priority: typeof entry.priority === "number" ? entry.priority : 2,
            issue_type:
                typeof entry.issue_type === "string" ? entry.issue_type : "",
            ...(typeof entry.closed_at === "string"
                ? { closed_at: entry.closed_at }
                : {}),
        });
    }

    return issues;
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

/** How each {@link Filter} orders its issues: closed ones by closing, the rest by priority. */
const ORDERS: Record<Filter, (a: Issue, b: Issue) => number> = {
    ready: byPriority,
    blocked: byPriority,
    open: byPriority,
    closed: byClosing,
    all: byPriority,
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
