import { expect, mock, test } from "claude-code/testing";
import type { On, PromptFillMode } from "claude-code";
import type { Engine as Kit, Mounted } from "claude-code/testing";

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
    {
        id: "bp-1.10",
        title: "Second",
        status: "in_progress",
        priority: 1,
        issue_type: "task",
    },
    {
        id: "bp-1",
        title: "First",
        status: "open",
        priority: 0,
        issue_type: "epic",
        description: "long",
    },
]);

/** One ready issue as `bd ready --json` prints it. */
const READY = JSON.stringify([
    {
        id: "bp-2",
        title: "Ready one",
        status: "open",
        priority: 2,
        issue_type: "bug",
    },
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

/**
 * The engine standing beneath the plugin: the bd runs it saw, the prompt box and the drafts put in it, a way to let background reads finish, and the clock a held answer sleeps on.
 * `isRefusing` set makes the box refuse every draft after.
 */
type Engine = {
    argvs: string[][];
    box: string;
    fills: { text: string; mode: PromptFillMode }[];
    isRefusing: boolean;
    settle: () => Promise<void>;
    clock: ReturnType<typeof mock.clock>;
};

/**
 * Answers the engine calls `/beads-pane` makes, with `bd` answered by subcommand from `runs`, but for the listing of the issues in progress, answered from `runs.in_progress`.
 * The issues in progress and `bd epic status` come back empty when `runs` has no answer for them.
 * A `{ deny }` answer makes that run reject, as when bd cannot start, and a function answers when its promise settles.
 * Answers `ui.panes` with the panes `ui.open` was asked for, the end of a turn with its answer, the working directory with `/repo`, `fs.read` from `files`, a path missing there being refused, and the prompt box from `box`, which a draft replaces or extends.
 * Returns the argument vectors bd was run with, the prompt box and its drafts, `settle`, which waits out the reads the command left running, and the mocked clock.
 */
function engine(
    on: On,
    runs: Record<string, Answer | (() => Promise<Answer>)>,
    files: Record<string, string> = {},
): Engine {
    const argvs: string[][] = [];
    const panes: string[] = [];
    const clock = mock.clock(on);
    const kit: Engine = {
        argvs,
        box: "",
        fills: [],
        isRefusing: false,
        settle: () => clock.settle(),
        clock,
    };
    on("command.register", (_, e) => ({ value: { command: e.name } }));
    on("ui.open", (_, e) => {
        panes.push(e.id);

        return { value: { isPlaced: true } };
    });
    on("ui.panes", () => ({
        value: panes.map((id) => ({
            id,
            title: id,
            isShown: true,
            isFocused: false,
            isPlaced: true,
        })),
    }));
    on("session.start", (_, e) => ({ cwd: e.cwd }));
    on("turn.complete", (_, e) => ({ text: e.answer }));
    on("session.cwd", () => ({ value: "/repo" }));
    on("prompt.read", () => ({
        value: { text: kit.box, cursor: kit.box.length },
    }));
    on("prompt.fill", (_, e) => {
        if (kit.isRefusing) {
            return { isFilled: false };
        }
        kit.fills.push({ text: e.text, mode: e.mode });
        kit.box = e.mode === "append" ? kit.box + e.text : e.text;

        return { isFilled: true };
    });
    on("fs.read", (_, e) => {
        const text = files[e.path];

        return text === undefined
            ? { deny: `ENOENT: ${e.path}` }
            : { value: text };
    });
    on("process.run", async (_, e) => {
        argvs.push([...e.argv]);
        const subcommand = e.argv.includes("in_progress")
            ? "in_progress"
            : (e.argv[1] ?? "");
        const answer =
            runs[subcommand] ??
            (subcommand === "in_progress" || subcommand === "epic"
                ? ran(0, "[]")
                : undefined);
        if (typeof answer === "function") {
            return await answer();
        }

        return answer ?? ran(1, "", `Error: unexpected ${e.argv.join(" ")}`);
    });

    return kit;
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
    return (await ui.findAll({ type: "Text" })).find(
        (one) => one.text === text,
    );
}

/** The bd command of each filter, as the pane runs them. */
const COMMANDS = {
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

/** The bd command that reads the issues in progress pinned atop the pane. */
const IN_PROGRESS = [
    "bd",
    "list",
    "--json",
    "--limit",
    "0",
    "--status",
    "in_progress",
];

/** The bd command that counts the children of the open epics. */
const EPICS = ["bd", "epic", "status", "--json"];

test("the pane lists open issues by priority, with status, priority, id, type and title", async ($, on) => {
    const bd = engine(on, {
        list: ran(0, LISTED),
        ready: ran(0, "[]"),
        blocked: ran(0, "[]"),
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();

    for (const surface of SURFACES) {
        const ui = await $.ui.mount({ ...PANE, surface });

        expect(await rows(ui)).toEqual([
            "○ P0bp-1epicFirst",
            "◐ P1bp-1.10taskSecond",
        ]);
        expect((await ui.find({ key: "filter-open" }))?.props.variant).toBe(
            "primary",
        );
        expect((await ui.find({ key: "filter-ready" }))?.props.variant).toBe(
            "secondary",
        );
        await ui.unmount();
    }
});

test("every column takes one width, so the titles start in the same column", async ($, on) => {
    const bd = engine(on, {
        list: ran(0, LISTED),
        ready: ran(0, "[]"),
        blocked: ran(0, "[]"),
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

    const widths = (await ui.findAll({ type: "Box" }))
        .filter((box) => box.props.flexShrink === 0)
        .map((box) => box.props.width);
    const columns = ["○ P0 ".length, "bp-1.10 ".length, "epic ".length];
    expect(widths).toEqual([...columns, ...columns]);
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
    const bd = engine(on, {
        list: ran(0, issues),
        ready: ran(0, "[]"),
        blocked: ran(0, "[]"),
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

    const colors = await Promise.all(
        [0, 1, 2, 3, 4].map(
            async (priority) =>
                (await exactText(ui, `P${priority}`))?.props.color,
        ),
    );
    expect(colors).toEqual([
        "#F07178",
        "#FF8F40",
        "#E6B450",
        undefined,
        undefined,
    ]);
    await ui.unmount();
});

test("status marks take bd's colors but an ice blue for deferred", async ($, on) => {
    const issues = JSON.stringify(
        ["open", "in_progress", "deferred", "held"].map((name, index) => ({
            id: `bp-${index}`,
            title: name,
            status: name === "held" ? "open" : name,
            priority: 2,
            issue_type: "task",
        })),
    );
    const bd = engine(on, {
        list: ran(0, issues),
        ready: ran(0, "[]"),
        blocked: ran(
            0,
            JSON.stringify([
                {
                    id: "bp-3",
                    title: "held",
                    status: "open",
                    priority: 2,
                    issue_type: "task",
                },
            ]),
        ),
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

    const marks = await Promise.all(
        ["○", "◐", "❄", "●"].map(
            async (mark) => (await exactText(ui, mark))?.props.color,
        ),
    );
    expect(marks).toEqual([undefined, "#FFB454", "#39BAE6", "#F07178"]);
    await ui.unmount();
});

test("the command reads the chosen filter first, then the issues in progress, the epics' progress and the others in the background", async ($, on) => {
    const bd = engine(on, {
        list: ran(0, LISTED),
        ready: ran(0, READY),
        blocked: ran(0, "[]"),
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();

    expect(bd.argvs).toEqual([
        COMMANDS.open,
        IN_PROGRESS,
        EPICS,
        COMMANDS.ready,
        COMMANDS.blocked,
        COMMANDS.closed,
        COMMANDS.all,
    ]);
});

test("a filter button draws the filter's last read at once, then reads it again", async ($, on) => {
    let readyAnswer = ran(0, READY);
    const bd = engine(on, {
        list: ran(0, LISTED),
        ready: async () => readyAnswer,
        blocked: ran(0, "[]"),
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    const before = bd.argvs.length;
    readyAnswer = ran(0, "[]");

    await ui.press({ key: "filter-ready" });
    expect(bd.argvs.slice(before)).toEqual([COMMANDS.ready]);
    expect((await ui.find({ key: "filter-ready" }))?.props.variant).toBe(
        "primary",
    );
    expect((await ui.find({ key: "filter-open" }))?.props.variant).toBe(
        "secondary",
    );
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
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
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
    const bd = engine(on, {
        list: ran(0, "[]"),
        ready: ran(0, "[]"),
        blocked: ran(0, "[]"),
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

    for (const key of [
        "filter-ready",
        "filter-blocked",
        "filter-open",
        "filter-closed",
        "filter-all",
    ]) {
        await ui.press({ key });
    }
    expect(bd.argvs).toEqual([
        COMMANDS.ready,
        COMMANDS.blocked,
        COMMANDS.open,
        COMMANDS.closed,
        COMMANDS.all,
    ]);
    expect((await ui.find({ type: "Text" }))?.text).toBe("No issues.");
    await ui.unmount();
});

test("closed issues are drawn dim, their priority uncolored", async ($, on) => {
    const closed = JSON.stringify([
        {
            id: "bp-3",
            title: "Done",
            status: "closed",
            priority: 0,
            issue_type: "task",
        },
    ]);
    const bd = engine(on, { list: ran(0, closed) });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

    await ui.press({ key: "filter-all" });
    expect(await rows(ui)).toEqual(["✓ P0bp-3taskDone"]);
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

test("types take their own colors, the rest one tone between gray and plain", async ($, on) => {
    const typed = JSON.stringify(
        ["epic", "feature", "bug", "task", "chore"].map((type, n) => ({
            id: `bp-${n}`,
            title: "T",
            status: "open",
            priority: 2,
            issue_type: type,
        })),
    );
    const bd = engine(on, {
        list: ran(0, typed),
        ready: ran(0, "[]"),
        blocked: ran(0, "[]"),
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

    const colors = await Promise.all(
        ["epic", "feature", "bug", "task", "chore"].map(
            async (type) => (await exactText(ui, type))?.props.color,
        ),
    );
    expect(colors).toEqual([
        "#D2A6FF",
        "#59C2FF",
        "#F26D78",
        "#95E6CB",
        "#A6ACB3",
    ]);
    await ui.unmount();
});

test("pressing an id copies it on the surface it was pressed on and says so", async ($, on) => {
    const copied: unknown[] = [];
    const toasts: string[] = [];
    const bd = engine(on, {
        list: ran(0, LISTED),
        ready: ran(0, "[]"),
        blocked: ran(0, "[]"),
    });
    on("ui.copy", (_, e) => {
        copied.push(e);

        return { value: { isCopied: true } };
    });
    on("ui.toast", (_, e) => {
        toasts.push(e.text);

        return { value: undefined };
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

    await ui.press({ key: "copy-bp-1.10" });
    expect(copied).toEqual([{ text: "bp-1.10", surface: "desktop" }]);
    expect(toasts).toEqual(["Copied bp-1.10"]);
    await ui.unmount();
});

test("a copy the surface refuses says why", async ($, on) => {
    const toasts: string[] = [];
    const bd = engine(on, {
        list: ran(0, LISTED),
        ready: ran(0, "[]"),
        blocked: ran(0, "[]"),
    });
    on("ui.copy", () => ({
        value: { isCopied: false, reason: "no-clipboard" },
    }));
    on("ui.toast", (_, e) => {
        toasts.push(e.text);

        return { value: undefined };
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

    await ui.press({ key: "copy-bp-1" });
    expect(toasts).toEqual([
        "Could not copy bp-1: the clipboard is not reachable",
    ]);
    await ui.unmount();
});

test("an open issue that bd blocked lists is marked blocked in every other filter", async ($, on) => {
    const blocked = JSON.stringify([
        {
            id: "bp-1.10",
            title: "Second",
            status: "open",
            priority: 1,
            issue_type: "task",
            blocked_by: ["bp-1"],
        },
    ]);
    const listed = JSON.stringify([
        {
            id: "bp-1",
            title: "First",
            status: "open",
            priority: 0,
            issue_type: "epic",
        },
        {
            id: "bp-1.10",
            title: "Second",
            status: "open",
            priority: 1,
            issue_type: "task",
        },
    ]);
    const bd = engine(on, {
        list: ran(0, listed),
        ready: ran(0, "[]"),
        blocked: ran(0, blocked),
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

    expect(await rows(ui)).toEqual([
        "○ P0bp-1epicFirst",
        "● P1bp-1.10taskSecond",
    ]);
    await ui.unmount();
});

test("rows keep their columns at the top, with room between them", async ($, on) => {
    const bd = engine(on, {
        list: ran(0, LISTED),
        ready: ran(0, "[]"),
        blocked: ran(0, "[]"),
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

    const boxes = await ui.findAll({ type: "Box" });
    const rowBoxes = boxes.filter((box) => box.key?.startsWith("issue-"));
    expect(rowBoxes.map((box) => box.props.alignItems)).toEqual([
        "flex-start",
        "flex-start",
    ]);
    expect(
        boxes.find((box) => box.props.rowGap !== undefined)?.props.rowGap,
    ).toBe("xs");
    await ui.unmount();
});

test("closed issues come by closing time, the latest first, whatever their priority", async ($, on) => {
    const closed = JSON.stringify([
        {
            id: "bp-1",
            title: "Early",
            status: "closed",
            priority: 0,
            issue_type: "task",
            closed_at: "2026-10-28T19:04:19Z",
        },
        {
            id: "bp-2",
            title: "Late",
            status: "closed",
            priority: 3,
            issue_type: "task",
            closed_at: "2026-10-28T20:02:36Z",
        },
        {
            id: "bp-3",
            title: "Middle",
            status: "closed",
            priority: 1,
            issue_type: "task",
            closed_at: "2026-10-28T19:43:39Z",
        },
    ]);
    const bd = engine(on, {
        list: ran(0, closed),
        ready: ran(0, "[]"),
        blocked: ran(0, "[]"),
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

    await ui.press({ key: "filter-closed" });
    expect(await rows(ui)).toEqual([
        "✓ P3bp-2taskLate",
        "✓ P1bp-3taskMiddle",
        "✓ P0bp-1taskEarly",
    ]);
    await ui.press({ key: "filter-all" });
    expect(await rows(ui)).toEqual([
        "✓ P0bp-1taskEarly",
        "✓ P1bp-3taskMiddle",
        "✓ P3bp-2taskLate",
    ]);
    await bd.settle();
    await ui.unmount();
});

/** An issue linked to a card, as `bd show --json` lists it among the dependencies or dependents. */
function link(id: string, type: string, status = "open") {
    return {
        id,
        title: `Title of ${id}`,
        status,
        priority: 2,
        issue_type: "task",
        created_at: "0001-01-01T00:00:00Z",
        updated_at: "0001-01-01T00:00:00Z",
        dependency_type: type,
    };
}

/** The card of `bp-1.10` as `bd show --json --include-dependents --include-comments` prints it. */
const SHOWN = JSON.stringify([
    {
        id: "bp-1.10",
        title: "Second",
        description: "Line one\r\nLine **two**",
        design: "",
        notes: "Some notes",
        status: "in_progress",
        priority: 1,
        issue_type: "task",
        assignee: "bob",
        owner: "owner@example.com",
        created_by: "carol",
        created_at: "2026-10-20T08:00:00Z",
        updated_at: "2026-10-28T09:30:00Z",
        labels: ["core", "ui"],
        dependencies: [
            link("bp-9", "blocks", "closed"),
            link("bp-7", "relates-to"),
            link("bp-1", "parent-child"),
        ],
        dependents: [
            link("bp-7", "relates-to"),
            link("bp-8", "blocks", "in_progress"),
        ],
        comments: [
            {
                id: "c1",
                issue_id: "bp-1.10",
                author: "alice",
                text: "Looks *fine*",
                created_at: "2026-10-27T12:00:00Z",
            },
        ],
        parent: "bp-1",
    },
]);

/** Opens the pane on `LISTED` with `bd show` answered by `shown`, and returns the mounted pane and the bd runs. */
async function opened($: Kit, on: On, shown: Answer | (() => Promise<Answer>)) {
    const bd = engine(on, {
        list: ran(0, LISTED),
        ready: ran(0, "[]"),
        blocked: ran(0, "[]"),
        show: shown,
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();

    return { bd, ui: await $.ui.mount({ ...PANE, surface: "desktop" }) };
}

test("pressing a title opens its card under the row with one bd show", async ($, on) => {
    const { bd, ui: pressed } = await opened($, on, ran(0, SHOWN));
    const before = bd.argvs.length;

    await pressed.press({ key: "card-bp-1.10" });
    expect(bd.argvs.slice(before)).toEqual([
        [
            "bd",
            "show",
            "bp-1.10",
            "--json",
            "--include-dependents",
            "--include-comments",
        ],
    ]);
    await pressed.unmount();

    for (const surface of SURFACES) {
        const ui = await $.ui.mount({ ...PANE, surface });
        expect(
            (await ui.findAll({ type: "Box" }))
                .map((box) => box.key ?? "")
                .filter((key) => /^(issue|details)-/.test(key)),
        ).toEqual(["issue-bp-1", "issue-bp-1.10", "details-bp-1.10"]);
        expect(
            (
                await exactText(
                    ui,
                    "in progress · owner carol · assignee bob · labels core, ui · created 2026-10-20 · updated 2026-10-28",
                )
            )?.props.dimColor,
        ).toBe(true);
        expect(
            (await ui.findAll({ type: "Markdown" })).map(
                (one) => one.props.text,
            ),
        ).toEqual(["Line one\nLine **two**", "Some notes", "Looks *fine*"]);
        for (const heading of [
            "Description",
            "Notes",
            "Parent",
            "Depends on",
            "Blocks",
            "Related",
            "Comments",
        ]) {
            expect(await exactText(ui, heading)).toBeDefined();
        }
        for (const heading of ["Design", "Acceptance criteria", "Children"]) {
            expect(await exactText(ui, heading)).toBeUndefined();
        }
        expect(
            (await ui.findAll({ type: "Box" }))
                .filter((box) => box.key?.startsWith("link-"))
                .map((box) => box.text),
        ).toEqual([
            "○ P2bp-1Title of bp-1",
            "✓ P2bp-9Title of bp-9",
            "◐ P2bp-8Title of bp-8",
            "○ P2bp-7Title of bp-7",
        ]);
        expect(await exactText(ui, "alice · 2026-10-27")).toBeDefined();
        await ui.unmount();
    }
});

test("pressing the title of the open card closes it, and opening it again draws the last read at once", async ($, on) => {
    let answers = 0;
    let gate = Promise.resolve();
    const { ui } = await opened($, on, async () => {
        answers += 1;
        await gate;

        return ran(0, SHOWN);
    });

    await ui.press({ key: "card-bp-1.10" });
    await ui.press({ key: "card-bp-1.10" });
    expect(await ui.find({ key: "details-bp-1.10" })).toBeUndefined();
    await ui.press({ key: "card-bp-1" });
    expect(await ui.find({ key: "details-bp-1.10" })).toBeUndefined();
    expect(await ui.find({ key: "details-bp-1" })).toBeDefined();

    let release = () => {};
    gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    const pressing = ui.press({ key: "card-bp-1.10" });
    expect(
        (await ui.findAll({ type: "Markdown" })).map((one) => one.props.text),
    ).toContain("Some notes");
    expect(answers).toBe(3);
    release();
    await pressing;
    await ui.unmount();
});

test("a card bd cannot read says why", async ($, on) => {
    const { ui } = await opened(
        $,
        on,
        ran(
            1,
            JSON.stringify({
                error: "no issues found matching the provided IDs",
            }),
            'Error fetching bp-1.10: no issue found matching "bp-1.10"',
        ),
    );

    await ui.press({ key: "card-bp-1.10" });
    expect((await ui.find({ key: "details-bp-1.10" }))?.text).toBe(
        'bd failed: Error fetching bp-1.10: no issue found matching "bp-1.10"',
    );
    await ui.unmount();
});

/** Collects the texts of the toasts the plugin shows. */
function toasts(on: On): string[] {
    const shown: string[] = [];
    on("ui.toast", (_, e) => {
        shown.push(e.text);

        return { value: undefined };
    });

    return shown;
}

/** The draft a card's take button puts in the prompt box for `bp-1.10`. */
const START_DRAFT =
    "Take beads issue bp-1.10 into work: Second\nClaim it with `bd update bp-1.10 --claim` and read it with `bd show bp-1.10`.";

test("the take button on a card drafts the request to claim and read the issue in the empty prompt box", async ($, on) => {
    const shown = toasts(on);
    const { bd, ui } = await opened($, on, ran(0, SHOWN));

    await ui.press({ key: "card-bp-1.10" });
    await ui.press({ key: "start-bp-1.10" });
    expect(bd.fills).toEqual([{ text: START_DRAFT, mode: "replace" }]);
    expect(shown).toEqual([
        "Drafted the request to start bp-1.10 in the prompt box",
    ]);
    await ui.unmount();
});

test("the take button keeps what the prompt box holds and drafts after a blank line", async ($, on) => {
    toasts(on);
    const { bd, ui } = await opened($, on, ran(0, SHOWN));
    bd.box = "my own words";

    await ui.press({ key: "card-bp-1.10" });
    await ui.press({ key: "start-bp-1.10" });
    expect(bd.box).toBe(`my own words\n\n${START_DRAFT}`);
    await ui.unmount();
});

test("a draft the prompt box refuses says so", async ($, on) => {
    const shown = toasts(on);
    const { bd, ui } = await opened($, on, ran(0, SHOWN));
    bd.isRefusing = true;

    await ui.press({ key: "card-bp-1.10" });
    await ui.press({ key: "start-bp-1.10" });
    expect(shown).toEqual([
        "Could not draft the request to start bp-1.10: the prompt box refused it",
    ]);
    await ui.unmount();
});

test("the close button on a card drafts the request to check the issue's work is done and close it with a reason", async ($, on) => {
    const shown = toasts(on);
    const { bd, ui } = await opened($, on, ran(0, SHOWN));

    await ui.press({ key: "card-bp-1.10" });
    await ui.press({ key: "close-bp-1.10" });
    expect(bd.fills).toEqual([
        {
            text: 'Close beads issue bp-1.10: Second\nCheck that its work is done, then close it with `bd close bp-1.10 --reason "<what was done>"`. If anything is left, tell me what instead of closing it.',
            mode: "replace",
        },
    ]);
    expect(shown).toEqual([
        "Drafted the request to close bp-1.10 in the prompt box",
    ]);
    expect(bd.argvs.some((argv) => argv[1] === "close")).toBe(false);
    await ui.unmount();
});

test("the next issue button drafts the request to pick the ready issue that fits the session and take it", async ($, on) => {
    const shown = toasts(on);
    const { bd, ui } = await opened($, on, ran(0, SHOWN));
    bd.box = "my own words";

    await ui.press({ key: "next" });
    expect(bd.box).toBe(
        "my own words\n\nTake the next beads issue into work: of the issues `bd ready` lists, pick the one that fits best with what this session has been doing, and tell me which and why.\nClaim it with `bd update <id> --claim` and read it with `bd show <id>`.",
    );
    expect(shown).toEqual([
        "Drafted the request to take the next issue in the prompt box",
    ]);
    await ui.unmount();
});

test("a closed issue's card has no take or close button", async ($, on) => {
    const bd = engine(on, {
        list: ran(
            0,
            JSON.stringify([
                {
                    id: "bp-3",
                    title: "Done",
                    status: "closed",
                    priority: 2,
                    issue_type: "task",
                    closed_at: "2026-10-28T10:00:00Z",
                },
            ]),
        ),
        ready: ran(0, "[]"),
        blocked: ran(0, "[]"),
        show: ran(0, SHOWN),
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

    await ui.press({ key: "card-bp-3" });
    expect(await ui.find({ key: "details-bp-3" })).toBeDefined();
    expect(await ui.find({ key: "start-bp-3" })).toBeUndefined();
    expect(await ui.find({ key: "close-bp-3" })).toBeUndefined();
    await ui.unmount();
});

test("an epic's card counts its closed children, and linked issues share one id column", async ($, on) => {
    const { ui } = await opened(
        $,
        on,
        ran(
            0,
            JSON.stringify([
                {
                    id: "bp-1",
                    title: "First",
                    status: "open",
                    priority: 0,
                    issue_type: "epic",
                    dependents: [
                        link("bp-1.1", "parent-child", "closed"),
                        link("bp-1.2", "parent-child"),
                        link("bp-1.10", "parent-child"),
                    ],
                },
            ]),
        ),
    );

    await ui.press({ key: "card-bp-1" });
    expect(
        (await ui.findAll({ type: "Text" })).find((one) =>
            one.text.startsWith("Children"),
        )?.text,
    ).toBe("Children 1/3 complete (33%)");
    const widths = (await ui.findAll({ type: "Box" }))
        .filter(
            (box) =>
                box.props.flexShrink === 0 &&
                box.props.width !== "○ P0 ".length,
        )
        .map((box) => box.props.width);
    expect(widths.slice(-3)).toEqual([
        "bp-1.10 ".length,
        "bp-1.10 ".length,
        "bp-1.10 ".length,
    ]);
    expect(
        (await ui.find({ key: "details-bp-1" }))?.props.backgroundColor,
    ).toBe("#8080801A");
    await ui.unmount();
});

test("the issues in progress are pinned atop the pane, where their card opens, and the block goes once none is left", async ($, on) => {
    let inProgress = ran(
        0,
        JSON.stringify([
            {
                id: "bp-1.10",
                title: "Second",
                status: "in_progress",
                priority: 1,
                issue_type: "task",
            },
        ]),
    );
    const bd = engine(on, {
        list: ran(0, LISTED),
        ready: ran(0, "[]"),
        blocked: ran(0, "[]"),
        show: ran(0, SHOWN),
        get in_progress() {
            return inProgress;
        },
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    const keys = async () =>
        (await ui.findAll({ type: "Box" }))
            .map((box) => box.key ?? "")
            .filter((key) => /^(pinned-issue|issue|details)-/.test(key));

    expect(await exactText(ui, "In progress")).toBeDefined();
    expect(await keys()).toEqual([
        "pinned-issue-bp-1.10",
        "issue-bp-1",
        "issue-bp-1.10",
    ]);
    expect((await ui.find({ key: "pinned-issue-bp-1.10" }))?.text).toBe(
        "◐ P1bp-1.10taskSecond",
    );

    await ui.press({ key: "card-bp-1.10" });
    expect(await keys()).toEqual([
        "pinned-issue-bp-1.10",
        "details-bp-1.10",
        "issue-bp-1",
        "issue-bp-1.10",
    ]);
    await ui.press({ key: "pinned-card-bp-1.10" });
    expect(await ui.find({ key: "details-bp-1.10" })).toBeUndefined();

    inProgress = ran(0, "[]");
    await ui.press({ key: "refresh" });
    expect(await ui.find({ key: "pinned" })).toBeUndefined();
    expect(await exactText(ui, "In progress")).toBeUndefined();
    await ui.unmount();
});

test("a filter button counts the issues of the filter's last read, and has no number before it", async ($, on) => {
    const bd = engine(on, {
        list: ran(0, LISTED),
        ready: ran(0, READY),
        blocked: ran(1, "", "Error: database is locked"),
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    const labels = async () =>
        (await ui.findAll({ type: "Button" }))
            .filter((button) => button.key?.startsWith("filter-"))
            .map((button) => button.props.label);

    expect(await labels()).toEqual([
        "Ready",
        "Blocked",
        "Open",
        "Closed",
        "All",
    ]);
    await $.command.run(TYPED);
    await bd.settle();
    expect(await labels()).toEqual([
        "Ready 1",
        "Blocked",
        "Open 2",
        "Closed 2",
        "All 2",
    ]);
    await ui.unmount();
});

/** The progress of epics as `bd epic status --json` prints it, with fields the pane drops. */
function epics(...counts: [id: string, closed: number, total: number][]) {
    return JSON.stringify(
        counts.map(([id, closed, total]) => ({
            epic: { id, title: id, status: "open", issue_type: "epic" },
            total_children: total,
            closed_children: closed,
            eligible_for_close: false,
        })),
    );
}

test("an epic's title is led by its closed children of all in the list and atop the pane, and a failed count keeps the last", async ($, on) => {
    let epicStatus = ran(0, epics(["bp-1", 1, 3], ["bp-5", 2, 4]));
    const bd = engine(on, {
        list: ran(0, LISTED),
        ready: ran(0, "[]"),
        blocked: ran(0, "[]"),
        in_progress: ran(
            0,
            JSON.stringify([
                {
                    id: "bp-5",
                    title: "Pinned",
                    status: "in_progress",
                    priority: 1,
                    issue_type: "epic",
                },
            ]),
        ),
        get epic() {
            return epicStatus;
        },
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });

    expect(await rows(ui)).toEqual([
        "○ P0bp-1epic(1/3) First",
        "◐ P1bp-1.10taskSecond",
    ]);
    expect((await ui.find({ key: "pinned-issue-bp-5" }))?.text).toBe(
        "◐ P1bp-5epic(2/4) Pinned",
    );

    epicStatus = ran(1, "", "Error: database is locked");
    await ui.press({ key: "refresh" });
    expect((await rows(ui))[0]).toBe("○ P0bp-1epic(1/3) First");

    epicStatus = ran(0, epics());
    await ui.press({ key: "refresh" });
    expect((await rows(ui))[0]).toBe("○ P0bp-1epicFirst");
    await ui.unmount();
});

/** The end of a turn of the main loop, as the engine raises it. */
const TURN_END = {
    answer: "",
    durationMs: 1,
    isAborted: false,
    turnId: "turn-1",
    reason: "answer",
} as const;

/** `bd where`, which a reload check runs while it does not know where the database is. */
const WHERE = ["bd", "where", "--json"];

/** Every filter read again, the pane's chosen `open` first, then the issues in progress and the epics' progress, as one reload runs them. */
const RELOAD = [
    COMMANDS.open,
    IN_PROGRESS,
    EPICS,
    COMMANDS.ready,
    COMMANDS.blocked,
    COMMANDS.closed,
    COMMANDS.all,
];

test("the end of a turn reads the open pane again, its open card last", async ($, on) => {
    const { bd, ui } = await opened($, on, ran(0, SHOWN));
    await ui.press({ key: "card-bp-1.10" });
    const before = bd.argvs.length;

    await $.turn.complete(TURN_END);
    await bd.settle();

    expect(bd.argvs.slice(before)).toEqual([
        WHERE,
        ...RELOAD,
        [
            "bd",
            "show",
            "bp-1.10",
            "--json",
            "--include-dependents",
            "--include-comments",
        ],
    ]);
    await ui.unmount();
});

test("no turn end reads bd while the pane is closed, nor a subagent's while it is open", async ($, on) => {
    const bd = engine(on, {
        list: ran(0, LISTED),
        ready: ran(0, "[]"),
        blocked: ran(0, "[]"),
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });

    await $.turn.complete(TURN_END);
    await bd.settle();
    expect(bd.argvs).toEqual([]);

    await $.command.run(TYPED);
    await bd.settle();
    const before = bd.argvs.length;
    await $.turn.complete({ ...TURN_END, agentId: "agent-1" });
    await bd.settle();
    expect(bd.argvs.slice(before)).toEqual([]);
});

test("a Bash command that runs bd reads the open pane again once it has run", async ($, on) => {
    const bd = engine(on, {
        list: ran(0, LISTED),
        ready: ran(0, "[]"),
        blocked: ran(0, "[]"),
    });
    const answered = {
        result: { stdout: "done", stderr: "", interrupted: false },
    };
    on("tool.call", (_, e) => {
        const command = e.tool === "Bash" ? e.command : "";
        bd.argvs.push(["Bash", command]);

        return command.includes("bp-2") ? { deny: "not now" } : answered;
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();
    const before = bd.argvs.length;

    const result = await $.tool.call({
        tool: "Bash",
        command: "cd /repo && bd close bp-1",
    });
    await bd.settle();
    await $.tool.call({ tool: "Bash", command: "ls" });
    await $.tool.call({ tool: "Bash", command: "bd close bp-2" });
    await bd.settle();

    expect(result.result).toEqual(answered.result);
    expect(bd.argvs.slice(before)).toEqual([
        ["Bash", "cd /repo && bd close bp-1"],
        WHERE,
        ...RELOAD,
        ["Bash", "ls"],
        ["Bash", "bd close bp-2"],
    ]);
});

test("reloads asked for during a reload read everything once more after it, never at once", async ($, on) => {
    let isHeld = false;
    const bd: Engine = engine(on, {
        list: async () => {
            if (isHeld) {
                await bd.clock.sleep(10);
            }

            return ran(0, LISTED);
        },
        ready: ran(0, "[]"),
        blocked: ran(0, "[]"),
    });
    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();
    const ui = await $.ui.mount({ ...PANE, surface: "desktop" });
    const before = bd.argvs.length;
    isHeld = true;

    const pressing = ui.press({ key: "refresh" });
    await bd.settle();
    const again = ui.press({ key: "refresh" });
    await $.turn.complete(TURN_END);
    await bd.settle();
    expect(bd.argvs.slice(before)).toEqual([COMMANDS.open, WHERE]);

    isHeld = false;
    await bd.clock.advance(10);
    await Promise.all([pressing, again]);
    await bd.settle();
    expect(bd.argvs.slice(before)).toEqual([
        COMMANDS.open,
        WHERE,
        ...RELOAD.slice(1),
        ...RELOAD,
    ]);
    await ui.unmount();
});

test("a turn end or a bd command reads nothing while the database version stays the same", async ($, on) => {
    const files: Record<string, string> = {
        "/repo/.beads/metadata.json": JSON.stringify({
            dolt_mode: "embedded",
            dolt_database: "bp",
        }),
        "/repo/.beads/embeddeddolt/bp/.dolt/noms/manifest": "version one",
    };
    const bd = engine(
        on,
        {
            list: ran(0, LISTED),
            ready: ran(0, "[]"),
            blocked: ran(0, "[]"),
            where: ran(
                0,
                JSON.stringify({
                    path: "/repo/.beads",
                    database_path: "/repo/.beads/embeddeddolt",
                    prefix: "bp",
                }),
            ),
        },
        files,
    );
    on("tool.call", () => ({
        result: { stdout: "", stderr: "", interrupted: false },
    }));
    await $.session.start({
        cwd: "/repo",
        surface: "desktop",
        isInteractive: true,
    });
    await $.command.run(TYPED);
    await bd.settle();
    const before = bd.argvs.length;

    await $.turn.complete(TURN_END);
    await bd.settle();
    expect(bd.argvs.slice(before)).toEqual([WHERE, ...RELOAD]);

    await $.tool.call({ tool: "Bash", command: "bd show bp-1" });
    await $.turn.complete(TURN_END);
    await bd.settle();
    expect(bd.argvs.slice(before)).toEqual([WHERE, ...RELOAD]);

    files["/repo/.beads/embeddeddolt/bp/.dolt/noms/manifest"] = "version two";
    await $.tool.call({ tool: "Bash", command: "bd close bp-1" });
    await bd.settle();
    expect(bd.argvs.slice(before)).toEqual([WHERE, ...RELOAD, ...RELOAD]);
});
