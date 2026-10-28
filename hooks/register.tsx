import { atom, read, update } from "claude-code";
import type { EngineInterface, Register } from "claude-code";

import type { Filter } from "../types";
import { fetchLoad } from "./bd";

/** Id of the side pane, shared by `$.ui.open` and the `Pane` render hook. */
export const PANE = "beads";

/** Title of the pane's tab while more than one pane is open. */
const TITLE = "Beads";

/** Slash command that opens the pane, typed as `/beads-pane`. */
const COMMAND = "beads-pane";

/** What the pane knows of the session's beads database, kept in the session's state. */
const load = atom(
    { plugin: "beads-pane", key: "load" } as const,
    { kind: "idle" },
    { shape: "load-2" },
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

/** Theme colors of the priorities worth drawing attention to; the rest are drawn dim. */
const PRIORITY_COLORS: Readonly<Record<number, string>> = {
    0: "error",
    1: "warning",
};

/**
 * Chooses `chosen` as the pane's filter, reads its issues from bd and stores them.
 * A result that arrives after another filter was chosen is dropped, so the list never shows a filter the switch does not.
 */
async function show($: EngineInterface, chosen: Filter): Promise<void> {
    await update($, filter, () => chosen);
    const loaded = await fetchLoad($, chosen);
    if ((await read($, filter)) === chosen) {
        await update($, load, () => loaded);
    }
}

/**
 * Registers the `/beads-pane` command and draws the beads pane.
 * The pane opens only on the command, never unasked at session start.
 * Each run of the command reads the issues of the chosen filter from bd again.
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
        await show($, await read($, filter));

        return {
            text: opened.isPlaced
                ? "Beads pane opened."
                : `Beads pane is waiting for room: ${opened.reason}`,
        };
    });

    on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
        const { Box, Button, Text } = $.ui.resolve(e);
        const state = await read($, load);
        const chosen = await read($, filter);

        if (state.kind === "missing") {
            return (
                <Box flexDirection="column">
                    <Text>No beads database for this folder.</Text>
                    <Text dimColor>
                        Run `bd init` here to start tracking issues.
                    </Text>
                </Box>
            );
        }

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
                                void show($, one.filter);
                            }}
                        />
                    ))}
                </Box>
                {state.kind === "idle" ? (
                    <Text dimColor>No issues loaded yet.</Text>
                ) : state.kind === "error" ? (
                    <Text color="error">bd failed: {state.message}</Text>
                ) : state.issues.length === 0 ? (
                    <Text dimColor>{empty}</Text>
                ) : (
                    <Box flexDirection="column">
                        {state.issues.map((issue) => (
                            <Text dimColor={issue.status === "closed"}>
                                {STATUS_MARKS[issue.status] ?? "?"}{" "}
                                <Text
                                    color={PRIORITY_COLORS[issue.priority]}
                                    dimColor={
                                        PRIORITY_COLORS[issue.priority] ===
                                        undefined
                                    }
                                >
                                    P{issue.priority}
                                </Text>{" "}
                                <Text dimColor>{issue.id}</Text> {issue.title}
                                {issue.issue_type === "task" ? (
                                    ""
                                ) : (
                                    <Text dimColor> · {issue.issue_type}</Text>
                                )}
                            </Text>
                        ))}
                    </Box>
                )}
            </Box>
        );
    });
};
