import { atom, read, update } from "claude-code";
import type { EngineInterface, Register, RenderSurface } from "claude-code";

import type { Filter, Issue, Load } from "../types";
import { fetchLoad } from "./bd";

/** Id of the side pane, shared by `$.ui.open` and the `Pane` render hook. */
export const PANE = "beads";

/** Title of the pane's tab while more than one pane is open. */
const TITLE = "Beads";

/** Slash command that opens the pane, typed as `/beads-pane`. */
const COMMAND = "beads-pane";

/** The last read of each filter, kept in the session's state so a switch draws at once. */
const lists = atom(
    { plugin: "beads-pane", key: "lists" } as const,
    {},
    { shape: "lists-2" },
);

/** The {@link Filter} chosen in the pane, `open` until the person picks another. */
const filter = atom({ plugin: "beads-pane", key: "filter" } as const, "open", {
    shape: "filter-1",
});

/** The filter switch above the list, in the order its buttons are drawn. */
const FILTERS: readonly {
    /** The filter the button picks. */
    filter: Filter;
    /** The button's label. */
    label: string;
    /** The key that presses the button while the pane holds the focus. */
    hotkey: string;
    /** What the pane says when the filter lists nothing. */
    empty: string;
}[] = [
    { filter: "ready", label: "Ready", hotkey: "r", empty: "No ready issues." },
    {
        filter: "blocked",
        label: "Blocked",
        hotkey: "b",
        empty: "No blocked issues.",
    },
    { filter: "open", label: "Open", hotkey: "o", empty: "No open issues." },
    {
        filter: "closed",
        label: "Closed",
        hotkey: "c",
        empty: "No closed issues.",
    },
    { filter: "all", label: "All", hotkey: "a", empty: "No issues." },
];

/** The mark bd draws for a blocked issue. */
const BLOCKED_MARK = "●";

/** The mark bd itself draws for each status, leading every row. */
const STATUS_MARKS: Readonly<Record<string, string>> = {
    open: "○",
    in_progress: "◐",
    blocked: BLOCKED_MARK,
    deferred: "❄",
    closed: "✓",
};

/** The colors bd itself draws status marks in; the open mark is drawn as plain text. */
const STATUS_COLORS: Readonly<Record<string, string>> = {
    in_progress: "#FFB454",
    blocked: "#F07178",
    deferred: "#6C7680",
    closed: "#8090A0",
};

/** The colors bd itself draws priorities in; P3 and P4 are drawn as plain text. */
const PRIORITY_COLORS: Readonly<Record<number, string>> = {
    0: "#F07178",
    1: "#FF8F40",
    2: "#E6B450",
};

/**
 * Reads the issues of `which` from bd and stores them under that filter.
 * Returns what the read came to.
 */
async function refresh($: EngineInterface, which: Filter): Promise<Load> {
    const loaded = await fetchLoad($, which);
    await update($, lists, (all) => ({ ...all, [which]: loaded }));

    return loaded;
}

/**
 * Makes `chosen` the pane's filter and reads its issues again.
 * The list drawn meanwhile is the filter's last read, if any.
 */
async function choose($: EngineInterface, chosen: Filter): Promise<void> {
    await update($, filter, () => chosen);
    await refresh($, chosen);
}

/**
 * Reads the issues of every filter but `chosen`, one after another, so a later switch draws at once.
 * bd runs are not started together because concurrent reads of its embedded database are slower than serial ones.
 */
async function refreshOthers(
    $: EngineInterface,
    chosen: Filter,
): Promise<void> {
    for (const one of FILTERS) {
        if (one.filter !== chosen) {
            await refresh($, one.filter);
        }
    }
}

/**
 * Colors of the common issue types: bd's own purple for epics, blue for features, red for bugs and cyan for tasks.
 * Every other type takes {@link TYPE_COLOR}.
 */
const TYPE_COLORS: Readonly<Record<string, string>> = {
    epic: "#D2A6FF",
    feature: "#59C2FF",
    bug: "#F26D78",
    task: "#95E6CB",
};

/** Color of the remaining types, between bd's gray and the plain text. */
const TYPE_COLOR = "#A6ACB3";

/**
 * The mark leading a row: bd's mark for the issue's status, or the blocked mark for an issue the last `bd blocked` listed.
 * bd keeps such an issue `open`, since what holds it is an open dependency, not its own status.
 */
function markOf(issue: Issue, blocked: ReadonlySet<string>): string {
    return STATUS_MARKS[statusOf(issue, blocked)] ?? "?";
}

/** The status a row is drawn with: the issue's own, or `blocked` for an open issue the last `bd blocked` listed. */
function statusOf(issue: Issue, blocked: ReadonlySet<string>): string {
    return blocked.has(issue.id) && issue.status === "open"
        ? "blocked"
        : issue.status;
}

/** Width of the status and priority column, `○ P0` and a space. */
const MARK_WIDTH = "○ P0 ".length;

/** The widest value of `field` among `issues`, plus the space after the column. */
function columnWidth(
    issues: readonly Issue[],
    field: (issue: Issue) => string,
): number {
    return Math.max(0, ...issues.map((issue) => field(issue).length)) + 1;
}

/** What the toast says for each reason a copy did not take. */
const COPY_FAILURES: Readonly<
    Record<"no-surface" | "no-clipboard" | "refused", string>
> = {
    "no-surface": "nothing to copy on",
    "no-clipboard": "the clipboard is not reachable",
    refused: "the copy was refused",
};

/**
 * Puts an issue id on the clipboard of the surface it was pressed on and says how that went in a toast.
 */
async function copyId(
    $: EngineInterface,
    id: string,
    surface: RenderSurface,
): Promise<void> {
    const copied = await $.ui.copy({ text: id, surface });
    $.ui.toast(
        copied.isCopied
            ? `Copied ${id}`
            : `Could not copy ${id}: ${COPY_FAILURES[copied.reason]}`,
    );
}

/**
 * Registers the `/beads-pane` command and draws the beads pane.
 * The pane opens only on the command, never unasked at session start.
 * Each run of the command reads the chosen filter from bd again, then the other filters in the background.
 */
export const register: Register = (on) => {
    on("session.start", async ($, e, next) => {
        await $.command.register({
            name: COMMAND,
            description: "Show beads issues in a side pane",
        });

        return next(e);
    });

    on("command.run", { command: COMMAND }, async ($) => {
        const opened = await $.ui.open({ id: PANE, title: TITLE });
        const chosen = await read($, filter);
        if ((await refresh($, chosen)).kind === "ready") {
            void refreshOthers($, chosen);
        }

        return {
            text: opened.isPlaced
                ? "Beads pane opened."
                : `Beads pane is waiting for room: ${opened.reason}`,
        };
    });

    on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
        const { Box, Button, Text } = $.ui.resolve(e);
        const all = await read($, lists);
        const chosen = await read($, filter);
        const state = all[chosen];

        if (state?.kind === "missing") {
            return (
                <Box flexDirection="column">
                    <Text>No beads database for this folder.</Text>
                    <Text dimColor>
                        Run `bd init` here to start tracking issues.
                    </Text>
                </Box>
            );
        }

        const issues = state?.kind === "ready" ? state.issues : [];
        const blocked = new Set(
            all.blocked?.kind === "ready"
                ? all.blocked.issues.map((issue) => issue.id)
                : [],
        );
        const idWidth = columnWidth(issues, (issue) => issue.id);
        const typeWidth = columnWidth(issues, (issue) => issue.issue_type);
        const empty =
            FILTERS.find((one) => one.filter === chosen)?.empty ?? "No issues.";

        return (
            <Box flexDirection="column" gap={1}>
                <Box flexDirection="row" flexWrap="wrap" gap={1}>
                    {FILTERS.map((one) => (
                        <Button
                            key={`filter-${one.filter}`}
                            label={one.label}
                            hotkey={one.hotkey}
                            variant={
                                one.filter === chosen ? "primary" : "secondary"
                            }
                            onPress={() => {
                                void choose($, one.filter);
                            }}
                        />
                    ))}
                </Box>
                {state === undefined ? (
                    <Text dimColor>
                        {Object.keys(all).length === 0
                            ? "No issues loaded yet."
                            : "Loading…"}
                    </Text>
                ) : state.kind === "error" ? (
                    <Text color="error">bd failed: {state.message}</Text>
                ) : state.issues.length === 0 ? (
                    <Text dimColor>{empty}</Text>
                ) : (
                    <Box flexDirection="column" rowGap="xs">
                        {state.issues.map((issue) => {
                            const isClosed = issue.status === "closed";

                            return (
                                <Box
                                    key={`issue-${issue.id}`}
                                    flexDirection="row"
                                    alignItems="flex-start"
                                >
                                    <Box width={MARK_WIDTH} flexShrink={0}>
                                        <Text mono dimColor={isClosed}>
                                            <Text
                                                color={
                                                    STATUS_COLORS[
                                                        statusOf(issue, blocked)
                                                    ]
                                                }
                                            >
                                                {markOf(issue, blocked)}
                                            </Text>{" "}
                                            <Text
                                                color={
                                                    isClosed
                                                        ? undefined
                                                        : PRIORITY_COLORS[
                                                              issue.priority
                                                          ]
                                                }
                                                weight={
                                                    issue.priority === 0 &&
                                                    !isClosed
                                                        ? "bold"
                                                        : undefined
                                                }
                                            >
                                                P{issue.priority}
                                            </Text>
                                        </Text>
                                    </Box>
                                    <Box width={idWidth} flexShrink={0}>
                                        <Button
                                            key={`copy-${issue.id}`}
                                            plain
                                            dimColor
                                            onPress={(press) => {
                                                void copyId(
                                                    $,
                                                    issue.id,
                                                    press.surface,
                                                );
                                            }}
                                        >
                                            <Text mono>{issue.id}</Text>
                                        </Button>
                                    </Box>
                                    <Box width={typeWidth} flexShrink={0}>
                                        <Text
                                            mono
                                            dimColor={isClosed}
                                            color={
                                                isClosed
                                                    ? undefined
                                                    : (TYPE_COLORS[
                                                          issue.issue_type
                                                      ] ?? TYPE_COLOR)
                                            }
                                        >
                                            {issue.issue_type}
                                        </Text>
                                    </Box>
                                    <Box flexShrink={1}>
                                        <Text dimColor={isClosed}>
                                            {issue.title}
                                        </Text>
                                    </Box>
                                </Box>
                            );
                        })}
                    </Box>
                )}
            </Box>
        );
    });
};
