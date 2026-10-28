import { expect, mock, test } from "claude-code/testing";
import type { On } from "claude-code";
import type { Mounted } from "claude-code/testing";

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

/** Two issues as bd prints them, the less urgent first and with fields the pane drops. */
const LISTED = JSON.stringify([
    { id: "bp-1.10", title: "Second", status: "in_progress", priority: 1, issue_type: "task" },
    { id: "bp-1", title: "First", status: "open", priority: 0, issue_type: "epic", description: "long" },
]);

/** One ready issue as `bd ready --json` prints it. */
const READY = JSON.stringify([
    { id: "bp-2", title: "Ready one", status: "open", priority: 2, issue_type: "bug" },
]);

/** The rows of the issue list, the text of each in drawing order. */
async function rows(ui: Pick<Mounted, "findAll">): Promise<string[]> {
    return (await ui.findAll({ type: "Box" }))
        .filter((box) => box.key?.startsWith("issue-"))
        .map((box) => box.text);
}

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

/** How a hook standing for the engine answers one bd run. */
type Answer = ReturnType<typeof ran> | { deny: string };

/** The engine standing beneath the plugin: the bd runs it saw, and a way to let background reads finish. */
type Engine = { argvs: string[][]; settle: () => Promise<void> };

/**
 * Answers the engine calls `/beads-pane` makes, with `bd` answered by subcommand from `runs`.
 * A `{ deny }` answer makes that run reject, as when bd cannot start, and a function answers when its promise settles.
 * Returns the argument vectors bd was run with, and `settle`, which waits out the reads the command left running.
 */
function engine(
    on: On,
    runs: Record<string, Answer | (() => Promise<Answer>)>,
): Engine {
    const argvs: string[][] = [];
    const clock = mock.clock(on);
    on("command.register", (_, e) => ({ value: { command: e.name } }));
    on("ui.open", () => ({ value: { isPlaced: true } }));
    on("session.start", (_, e) => ({ cwd: e.cwd }));
    on("process.run", async (_, e) => {
        argvs.push([...e.argv]);
        const answer = runs[e.argv[1] ?? ""];
        if (typeof answer === "function") {
            return await answer();
        }

        return answer ?? ran(1, "", `Error: unexpected ${e.argv.join(" ")}`);
    });

    return { argvs, settle: () => clock.settle() };
}

test("/beads-pane is registered and opens the pane", async ($, on) => {
    const clock = mock.clock(on);
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

    await clock.settle();
    expect(opened).toEqual(["beads"]);
    expect(result.text).toBe("Beads pane opened.");
});

test("/beads-pane reports a pane that waits for room", async ($, on) => {
    const clock = mock.clock(on);
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
    await clock.settle();

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

/** The innermost Text whose whole text is `text`, as the priority of a row is drawn. */
async function exactText(ui: Pick<Mounted, "findAll">, text: string) {
    return (await ui.findAll({ type: "Text" })).find((one) => one.text === text);
}

/** The bd command of each filter, as the pane runs them. */
const COMMANDS = {
    ready: ["bd", "ready", "--json", "--limit", "0"],
    blocked: ["bd", "blocked", "--json"],
    open: ["bd", "list", "--json", "--limit", "0", "--status", "open,in_progress,blocked"],
    all: ["bd", "list", "--all", "--json", "--limit", "0"],
};

test("the pane lists open issues by priority, with status, priority, id, title and type", async ($, on) => {
    const bd = engine(on, { list: ran(0, LISTED), ready: ran(0, "[]"), blocked: ran(0, "[]") });
    await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
    await $.command.run(TYPED);
    await bd.settle();

    for (const surface of SURFACES) {
        const ui = await $.ui.mount({ ...PANE, surface });

        expect(await rows(ui)).toEqual(["○ P0 bp-1First · epic", "◐ P1 bp-1.10Second"]);
        expect((await ui.find({ key: "filter-open" }))?.props.variant).toBe("primary");
        expect((await ui.find({ key: "filter-ready" }))?.props.variant).toBe("secondary");
        await ui.unmount();
    }
});

test("ids take one width, so every title starts in the same column", async ($, on) => {
    const bd = engine(on, { list: ran(0, LISTED), ready: ran(0, "[]"), blocked: ran(0, "[]") });
    await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
    await $.command.run(TYPED);
    await bd.settle();
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

    const widths = (await ui.findAll({ type: "Box" }))
        .filter((box) => box.props.flexShrink === 0)
        .map((box) => box.props.width);
    expect(widths).toEqual(["○ P0 bp-1.10".length + 1, "○ P0 bp-1.10".length + 1]);
    await ui.unmount();
});

test("priorities take bd's colors, P3 and P4 plain", async ($, on) => {
    const issues = JSON.stringify(
        [0, 1, 2, 3, 4].map((priority) => ({
            id: `bp-${priority}`,
            title: "T",
            status: "open",
            priority,
            issue_type: "task",
        })),
    );
    const bd = engine(on, { list: ran(0, issues), ready: ran(0, "[]"), blocked: ran(0, "[]") });
    await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
    await $.command.run(TYPED);
    await bd.settle();
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

    const colors = await Promise.all(
        [0, 1, 2, 3, 4].map(async (priority) => (await exactText(ui, `P${priority}`))?.props.color),
    );
    expect(colors).toEqual(["#F07178", "#FF8F40", "#E6B450", undefined, undefined]);
    await ui.unmount();
});

test("the command reads the chosen filter first, then the others in the background", async ($, on) => {
    const bd = engine(on, { list: ran(0, LISTED), ready: ran(0, READY), blocked: ran(0, "[]") });
    await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
    await $.command.run(TYPED);
    await bd.settle();

    expect(bd.argvs).toEqual([COMMANDS.open, COMMANDS.ready, COMMANDS.blocked, COMMANDS.all]);
});

test("a filter button draws the filter's last read at once, then reads it again", async ($, on) => {
    let readyAnswer = ran(0, READY);
    const bd = engine(on, {
        list: ran(0, LISTED),
        ready: async () => readyAnswer,
        blocked: ran(0, "[]"),
    });
    await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
    await $.command.run(TYPED);
    await bd.settle();
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    const before = bd.argvs.length;
    readyAnswer = ran(0, "[]");

    await ui.press({ key: "filter-ready" });
    expect(bd.argvs.slice(before)).toEqual([COMMANDS.ready]);
    expect((await ui.find({ key: "filter-ready" }))?.props.variant).toBe("primary");
    expect((await ui.find({ key: "filter-open" }))?.props.variant).toBe("secondary");
    expect((await ui.find({ type: "Text" }))?.text).toBe("No ready issues.");

    await $.command.run(TYPED);

    await bd.settle();
    expect(bd.argvs[before + 1]).toEqual(COMMANDS.ready);
    await ui.unmount();
});

test("a filter never read says it is loading while bd answers", async ($, on) => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const bd = engine(on, {
        list: ran(0, LISTED),
        blocked: async () => {
            await gate;

            return ran(0, "[]");
        },
    });
    await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    await ui.press({ key: "filter-open" });

    const pressing = ui.press({ key: "filter-blocked" });
    expect((await ui.find({ type: "Text" }))?.text).toBe("Loading…");
    release();
    await pressing;
    expect((await ui.find({ type: "Text" }))?.text).toBe("No blocked issues.");
    await ui.unmount();
});

test("each filter runs its own bd command", async ($, on) => {
    const bd = engine(on, { list: ran(0, "[]"), ready: ran(0, "[]"), blocked: ran(0, "[]") });
    await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

    for (const key of ["filter-ready", "filter-blocked", "filter-open", "filter-all"]) {
        await ui.press({ key });
    }
    expect(bd.argvs).toEqual([COMMANDS.ready, COMMANDS.blocked, COMMANDS.open, COMMANDS.all]);
    expect((await ui.find({ type: "Text" }))?.text).toBe("No issues.");
    await ui.unmount();
});

test("closed issues are drawn dim, their priority uncolored", async ($, on) => {
    const closed = JSON.stringify([
        { id: "bp-3", title: "Done", status: "closed", priority: 0, issue_type: "task" },
    ]);
    const bd = engine(on, { list: ran(0, closed) });
    await $.session.start({ cwd: "/", surface: "desktop", isInteractive: true });
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

    await ui.press({ key: "filter-all" });
    expect(await rows(ui)).toEqual(["✓ P0 bp-3Done"]);
    expect((await exactText(ui, "Done"))?.props.dimColor).toBe(true);
    const priority = await exactText(ui, "P0");
    expect(priority).toBeDefined();
    expect(priority?.props.color).toBeUndefined();
    await ui.unmount();
});

test("an empty list says there are no open issues", async ($, on) => {
    const bd = engine(on, { list: ran(0, "[]") });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();

    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    expect((await ui.find({ type: "Text" }))?.text).toBe("No open issues.");
    await ui.unmount();
});

test("a folder without a beads database gets the bd init hint, not an error", async ($, on) => {
    const bd = engine(on, {
        list: ran(1, "", "Error: no beads database found\nHint: run 'bd init'"),
        where: ran(1, NO_DATABASE),
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();

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
    const bd = engine(on, {
        list: ran(1, "", "Error: database is locked\nHint: retry later"),
        where: ran(0, JSON.stringify({ path: "/repo/.beads", prefix: "bp" })),
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();

    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    expect((await ui.find({ type: "Text" }))?.text).toBe(
        "bd failed: database is locked",
    );
    await ui.unmount();
});

test("a JSON error message from bd wins over its stderr", async ($, on) => {
    const bd = engine(on, {
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
    await bd.settle();

    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    expect((await ui.find({ type: "Text" }))?.text).toBe(
        "bd failed: Schema too new.",
    );
    await ui.unmount();
});

test("output that is not a list of issues is an error", async ($, on) => {
    const bd = engine(on, { list: ran(0, "Warning: not JSON") });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();

    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    expect((await ui.find({ type: "Text" }))?.text).toBe(
        "bd failed: bd printed something other than a JSON list of issues.",
    );
    await ui.unmount();
});

test("a bd that cannot start is an error, and the command still answers", async ($, on) => {
    const bd = engine(on, { list: { deny: "spawn bd ENOENT" } });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    const result = await $.command.run(TYPED);
    await bd.settle();

    expect(result.text).toBe("Beads pane opened.");
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    expect((await ui.find({ type: "Text" }))?.text).toMatch(
        /^bd failed: Could not run bd: .*ENOENT/,
    );
    await ui.unmount();
});
