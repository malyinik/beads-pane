import { atom, read, update } from "claude-code";
import type { Register } from "claude-code";

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
    { shape: "load-1" },
);

/**
 * Registers the `/beads-pane` command and draws the beads pane.
 * The pane opens only on the command, never unasked at session start.
 * Each run of the command reads the issues from bd again.
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
        const loaded = await fetchLoad($);
        await update($, load, () => loaded);

        return {
            text: opened.isPlaced
                ? "Beads pane opened."
                : `Beads pane is waiting for room: ${opened.reason}`,
        };
    });

    on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
        const { Box, Text } = $.ui.resolve(e);
        const state = await read($, load);

        switch (state.kind) {
            case "idle":
                return <Text dimColor>No issues loaded yet.</Text>;
            case "missing":
                return (
                    <Box flexDirection="column">
                        <Text>No beads database for this folder.</Text>
                        <Text dimColor>
                            Run `bd init` here to start tracking issues.
                        </Text>
                    </Box>
                );
            case "error":
                return <Text color="error">bd failed: {state.message}</Text>;
            case "ready":
                return state.issues.length === 0 ? (
                    <Text dimColor>No open issues.</Text>
                ) : (
                    <Box flexDirection="column">
                        {state.issues.map((issue) => (
                            <Text>
                                {issue.id} {issue.title}
                            </Text>
                        ))}
                    </Box>
                );
        }
    });
};
