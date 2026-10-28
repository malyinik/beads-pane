import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

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
    { shape: "lists-1" },
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
    { filter: "all", label: "All", hotkey: "a", empty: "No issues." },
];

/** The mark bd itself draws for each status, leading every row. */
const STATUS_MARKS: Readonly<Record<string, string>> = {
    open: "○",
    in_progress: "◐",
    blocked: "●",
    deferred: "❄",
    closed: "✓",
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
async function refreshOthers($: EngineInterface, chosen: Filter): Promise<void> {
    for (const one of FILTERS) {
        if (one.filter !== chosen) {
            await refresh($, one.filter);
        }
    }
}

/** Width of the fixed part of a row: status mark, priority, an id of `idWidth` characters and the space before the title. */
function prefixWidth(idWidth: number): number {
    return "○ P0 ".length + idWidth + 1;
}

/** The type shown after a title, or nothing for a plain task. */
function typeSuffix(issue: Issue): string {
    return issue.issue_type === "task" ? "" : ` · ${issue.issue_type}`;
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

        const width = prefixWidth(
            state?.kind === "ready" ? Math.max(0, ...state.issues.map((one) => one.id.length)) : 0,
        );
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
                        {Object.keys(all).length === 0 ? "No issues loaded yet." : "Loading…"}
                    </Text>
                ) : state.kind === "error" ? (
                    <Text color="error">bd failed: {state.message}</Text>
                ) : state.issues.length === 0 ? (
                    <Text dimColor>{empty}</Text>
                ) : (
                    <Box flexDirection="column">
                        {state.issues.map((issue) => {
                            const isClosed = issue.status === "closed";

                            return (
                                <Box key={`issue-${issue.id}`} flexDirection="row">
                                    <Box width={width} flexShrink={0}>
                                        <Text mono dimColor={isClosed}>
                                            {STATUS_MARKS[issue.status] ?? "?"}{" "}
                                            <Text
                                                color={isClosed ? undefined : PRIORITY_COLORS[issue.priority]}
                                                weight={issue.priority === 0 && !isClosed ? "bold" : undefined}
                                            >
                                                P{issue.priority}
                                            </Text>{" "}
                                            <Text dimColor>{issue.id}</Text>
                                        </Text>
                                    </Box>
                                    <Box flexShrink={1}>
                                        <Text dimColor={isClosed}>
                                            {issue.title}
                                            <Text dimColor>{typeSuffix(issue)}</Text>
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
