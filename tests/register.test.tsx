import { expect, test } from "claude-code/testing";
import type { On } from "claude-code";

const SURFACES = ["terminal", "desktop"] as const;

const PANE = {
    plugin: "beads-pane",
    component: "Pane",
    requestId: "beads",
    props: {
        title: "Beads",
        isFocused: false,
        bodyColumns: 40,
        placement: "dock",
        scroll: { offset: 0, bodyRows: 20 },
        view: {},
    },
} as const;

/** `/beads-pane` as the person types it in the fullscreen terminal. */
const TYPED = {
    command: "beads-pane",
    args: "",
    origin: { kind: "composer" },
    presentation: { isFullscreen: true, columns: 120 },
} as const;

/** Two open issues as `bd list --json` prints them, with fields the pane drops. */
const LISTED = JSON.stringify([
    {
        id: "bp-1",
        title: "First",
        status: "open",
        priority: 0,
        issue_type: "epic",
        description: "long",
    },
    {
        id: "bp-1.1",
        title: "Second",
        status: "in_progress",
        priority: 1,
        issue_type: "task",
    },
]);

/** What `bd where --json` prints, exiting 1, when no database is found. */
const NO_DATABASE = JSON.stringify({
    error: "no_beads_directory",
    message: "No active beads workspace found.",
});

/** A bd run that exited with `exitCode`, as a hook standing for the engine answers `$.process.run`. */
function ran(exitCode: number, stdout: string, stderr = "") {
    return {
        value: {
            exitCode,
            stdout,
            stderr,
            isStdoutTruncated: false,
            isStderrTruncated: false,
        },
    };
}

/**
 * Answers the engine calls `/beads-pane` makes, with `bd` answered by subcommand from `runs`.
 * A `{ deny }` answer makes that run reject, as when bd cannot start.
 * Returns the argument vectors bd was run with.
 */
function engine(
    on: On,
    runs: Record<string, ReturnType<typeof ran> | { deny: string }>,
): string[][] {
    const argvs: string[][] = [];
    on("command.register", (_, e) => ({ value: { command: e.name } }));
    on("ui.open", () => ({ value: { isPlaced: true } }));
    on("session.start", (_, e) => ({ cwd: e.cwd }));
    on("process.run", (_, e) => {
        argvs.push([...e.argv]);

        return (
            runs[e.argv[1] ?? ""] ??
            ran(1, "", `Error: unexpected ${e.argv.join(" ")}`)
        );
    });

    return argvs;
}

test("/beads-pane is registered and opens the pane", async ($, on) => {
    const registered: string[] = [];
    const opened: string[] = [];
    on("command.register", (_, e) => {
        registered.push(e.name);

        return { value: { command: e.name } };
    });
    on("ui.open", (_, e) => {
        opened.push(e.id);

        return { value: { isPlaced: true } };
    });
    on("session.start", (_, e) => ({ cwd: e.cwd }));
    on("process.run", () => ran(0, "[]"));

    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    expect(registered).toEqual(["beads-pane"]);
    expect(opened).toEqual([]);

    const result = await $.command.run(TYPED);
    expect(opened).toEqual(["beads"]);
    expect(result.text).toBe("Beads pane opened.");
});

test("/beads-pane reports a pane that waits for room", async ($, on) => {
    on("command.register", (_, e) => ({ value: { command: e.name } }));
    on("ui.open", () => ({ value: { isPlaced: false, reason: "no-surface" } }));
    on("session.start", (_, e) => ({ cwd: e.cwd }));
    on("process.run", () => ran(0, "[]"));

    await $.session.start({
        cwd: "/",
        surface: "terminal",
        isInteractive: true,
    });
    const result = await $.command.run(TYPED);

    expect(result.text).toBe("Beads pane is waiting for room: no-surface");
});

test("the pane draws a placeholder before the first load", async ($) => {
    for (const surface of SURFACES) {
        const ui = await $.ui.mount({ ...PANE, surface });

        expect((await ui.find({ type: "Text" }))?.text).toBe(
            "No issues loaded yet.",
        );
        await ui.unmount();
    }
});

test("the pane lists every open issue bd reports", async ($, on) => {
    const argvs = engine(on, { list: ran(0, LISTED) });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);

    expect(argvs).toEqual([["bd", "list", "--json", "--limit", "0"]]);
    for (const surface of SURFACES) {
        const ui = await $.ui.mount({ ...PANE, surface });

        expect((await ui.find({ type: "Text", text: /bp-1 / }))?.text).toBe(
            "bp-1 First",
        );
        expect((await ui.find({ type: "Text", text: /bp-1\.1/ }))?.text).toBe(
            "bp-1.1 Second",
        );
        await ui.unmount();
    }
});

test("an empty list says there are no open issues", async ($, on) => {
    engine(on, { list: ran(0, "[]") });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);

    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    expect((await ui.find({ type: "Text" }))?.text).toBe("No open issues.");
    await ui.unmount();
});

test("a folder without a beads database gets the bd init hint, not an error", async ($, on) => {
    engine(on, {
        list: ran(1, "", "Error: no beads database found\nHint: run 'bd init'"),
        where: ran(1, NO_DATABASE),
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);

    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    expect((await ui.find({ type: "Text", text: /database/ }))?.text).toBe(
        "No beads database for this folder.",
    );
    expect((await ui.find({ type: "Text", text: /bd init/ }))?.text).toBe(
        "Run `bd init` here to start tracking issues.",
    );
    expect(await ui.find({ type: "Text", text: /failed/ })).toBeUndefined();
    await ui.unmount();
});

test("a bd failure shows the first line of its stderr", async ($, on) => {
    engine(on, {
        list: ran(1, "", "Error: database is locked\nHint: retry later"),
        where: ran(0, JSON.stringify({ path: "/repo/.beads", prefix: "bp" })),
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);

    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    expect((await ui.find({ type: "Text" }))?.text).toBe(
        "bd failed: database is locked",
    );
    await ui.unmount();
});

test("a JSON error message from bd wins over its stderr", async ($, on) => {
    engine(on, {
        list: ran(
            1,
            JSON.stringify({ error: "x", message: "Schema too new." }),
            "Error: noise",
        ),
        where: ran(0, "{}"),
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);

    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    expect((await ui.find({ type: "Text" }))?.text).toBe(
        "bd failed: Schema too new.",
    );
    await ui.unmount();
});

test("output that is not a list of issues is an error", async ($, on) => {
    engine(on, { list: ran(0, "Warning: not JSON") });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);

    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    expect((await ui.find({ type: "Text" }))?.text).toBe(
        "bd failed: bd list printed something other than a JSON list of issues.",
    );
    await ui.unmount();
});

test("a bd that cannot start is an error, and the command still answers", async ($, on) => {
    engine(on, { list: { deny: "spawn bd ENOENT" } });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    const result = await $.command.run(TYPED);

    expect(result.text).toBe("Beads pane opened.");
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    expect((await ui.find({ type: "Text" }))?.text).toMatch(
        /^bd failed: Could not run bd: .*ENOENT/,
    );
    await ui.unmount();
});
