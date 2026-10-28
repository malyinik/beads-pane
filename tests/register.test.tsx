import { expect, test } from "claude-code/testing";

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

    await $.session.start({
        cwd: "/",
        surface: "desktop",
        isInteractive: true,
    });
    expect(registered).toEqual(["beads-pane"]);
    expect(opened).toEqual([]);

    const ran = await $.command.run(TYPED);
    expect(opened).toEqual(["beads"]);
    expect(ran.text).toBe("Beads pane opened.");
});

test("/beads-pane reports a pane that waits for room", async ($, on) => {
    on("command.register", (_, e) => ({ value: { command: e.name } }));
    on("ui.open", () => ({ value: { isPlaced: false, reason: "no-surface" } }));
    on("session.start", (_, e) => ({ cwd: e.cwd }));

    await $.session.start({
        cwd: "/",
        surface: "terminal",
        isInteractive: true,
    });
    const ran = await $.command.run(TYPED);

    expect(ran.text).toBe("Beads pane is waiting for room: no-surface");
});

test("the pane draws a placeholder on every surface", async ($) => {
    for (const surface of SURFACES) {
        const ui = await $.ui.mount({ ...PANE, surface });

        expect((await ui.find({ type: "Text" }))?.text).toBe(
            "No issues loaded yet.",
        );
        await ui.unmount();
    }
});
