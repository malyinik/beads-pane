import type { EngineInterface, ProcessRunResult } from "claude-code";

import type { Issue, Load } from "../types";

/** `bd list` with every open issue, past bd's default limit of 50. */
const LIST = ["bd", "list", "--json", "--limit", "0"] as const;

/** `bd where`, which names the workspace bd resolves for the working directory. */
const WHERE = ["bd", "where", "--json"] as const;

/** The `error` code `bd where --json` reports when no beads database is found. */
const NO_DATABASE = "no_beads_directory";

/**
 * Runs `bd list` in the session's working directory and turns its outcome into a {@link Load}.
 * Never rejects: a bd that fails or cannot start comes back as an `error` load.
 */
export async function fetchLoad($: EngineInterface): Promise<Load> {
    let listed: ProcessRunResult;
    try {
        listed = await $.process.run(LIST);
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
              message:
                  "bd list printed something other than a JSON list of issues.",
          }
        : { kind: "ready", issues };
}

/**
 * Tells a missing database from any other failure of `bd list`.
 * `bd list` reports a missing database only as text on stderr, so the check asks `bd where`, which reports it as a JSON error code.
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
        });
    }

    return issues;
}

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
