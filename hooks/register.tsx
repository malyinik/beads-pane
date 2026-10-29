import { atom, read, update } from "claude-code";
import type { EngineInterface, Register, RenderSurface } from "claude-code";

import type { Card, CardLoad, Filter, Issue, Load } from "../types";
import { fetchCard, fetchLoad, fetchProgress, fetchVersion } from "./bd";

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
    { shape: "lists-3" },
);

/** The {@link Filter} chosen in the pane, `open` until the person picks another. */
const filter = atom({ plugin: "beads-pane", key: "filter" } as const, "open", {
    shape: "filter-1",
});

/** The id of the issue whose card is open under its row, `null` while every card is closed. */
const expanded = atom(
    { plugin: "beads-pane", key: "expanded" } as const,
    null,
    { shape: "expanded-1" },
);

/** The last read of each card opened, by issue id, so a card opened again draws at once. */
const cards = atom(
    { plugin: "beads-pane", key: "cards" } as const,
    {},
    {
        shape: "cards-2",
    },
);

/** The last read of the issues in progress, drawn atop the pane whatever the filter; `null` before the first read. */
const working = atom({ plugin: "beads-pane", key: "working" } as const, null, {
    shape: "working-2",
});

/** The progress of each open epic as last read, drawn before the epic's title; a failed read leaves the last one. */
const progress = atom(
    { plugin: "beads-pane", key: "progress" } as const,
    {},
    { shape: "progress-2" },
);

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
        filter: "deferred",
        label: "Deferred",
        hotkey: "d",
        empty: "No deferred issues.",
    },
    {
        filter: "closed",
        label: "Closed",
        hotkey: "c",
        empty: "No closed issues.",
    },
    { filter: "all", label: "All", hotkey: "a", empty: "No issues." },
];

/** A filter button's label, followed by the number of issues of the filter's last read when that read succeeded, as `Ready 7`. */
function labelOf(label: string, load: Load | undefined): string {
    return load?.kind === "ready" ? `${label} ${load.issues.length}` : label;
}

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

/**
 * The colors status marks are drawn in, bd's own but for the deferred mark, which bd draws gray and the pane in ice blue so it does not read as closed.
 * The open mark is drawn as plain text.
 */
const STATUS_COLORS: Readonly<Record<string, string>> = {
    in_progress: "#FFB454",
    blocked: "#F07178",
    deferred: "#39BAE6",
    closed: "#8090A0",
};

/** The mark of an open epic whose children are all closed, so it is ready to close, and its green. */
const DONE_MARK = { mark: "◉", color: "#AAD94C" };

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
 * Reads the issues in progress, the progress of the epics, then the issues of every filter but `chosen`, one after another, so a later switch draws at once.
 * bd runs are not started together because concurrent reads of its embedded database are slower than serial ones.
 */
async function refreshOthers(
    $: EngineInterface,
    chosen: Filter,
): Promise<void> {
    const loaded = await fetchLoad($, "in_progress");
    await update($, working, () => loaded);
    const counted = await fetchProgress($);
    if (counted !== undefined) {
        await update($, progress, () => counted);
    }
    for (const one of FILTERS) {
        if (one.filter !== chosen) {
            await refresh($, one.filter);
        }
    }
}

/** Reads the card of issue `id` from bd and stores it under that id. */
async function refreshCard($: EngineInterface, id: string): Promise<void> {
    const loaded = await fetchCard($, id);
    await update($, cards, (all) => ({ ...all, [id]: loaded }));
}

/**
 * Opens the card of issue `id` under its row and reads it again, or closes it when it is the open one.
 * Only one card is open at a time.
 * The card drawn meanwhile is the issue's last read, if any.
 */
async function toggle($: EngineInterface, id: string): Promise<void> {
    const opened = (await read($, expanded)) === id ? null : id;
    await update($, expanded, () => opened);
    if (opened !== null) {
        await refreshCard($, opened);
    }
}

/**
 * Reads again everything the pane draws: the chosen filter, then the issues in progress, the epics' progress and the other filters one by one, then the open card.
 * The others and the card are left alone when the chosen filter's read fails.
 */
async function refreshAll($: EngineInterface): Promise<void> {
    const chosen = await read($, filter);
    if ((await refresh($, chosen)).kind !== "ready") {
        return;
    }
    await refreshOthers($, chosen);
    const opened = await read($, expanded);
    if (opened !== null) {
        await refreshCard($, opened);
    }
}

/** The {@link reload} running now, if any. */
let reloading: Promise<void> | undefined;

/** Whether {@link reload} was asked for again while {@link reloading} ran. */
let isStale = false;

/**
 * Runs {@link refreshAll}, or, while one runs, makes it read everything once more when it is through.
 * Asks that come during a run never start a second one, since concurrent bd reads are slower than serial ones.
 * Settles once nothing is left to read.
 */
function reload($: EngineInterface): Promise<void> {
    if (reloading !== undefined) {
        isStale = true;

        return reloading;
    }
    reloading = (async () => {
        do {
            isStale = false;
            await refreshAll($);
        } while (isStale);
    })().finally(() => {
        reloading = undefined;
    });

    return reloading;
}

/** The database version the last {@link reloadChanged} read from, `undefined` before its first. */
let readVersion: string | undefined;

/**
 * Runs {@link reload} while the pane is open and bd's database changed since the last such reload.
 * A database whose version cannot be told is read every time, and a closed pane is read on the next `/beads-pane` instead.
 */
async function reloadChanged($: EngineInterface): Promise<void> {
    if (!(await $.ui.panes()).some((pane) => pane.id === PANE)) {
        return;
    }
    const version = await fetchVersion($);
    if (version === undefined || version !== readVersion) {
        readVersion = version;
        await reload($);
    }
}

/**
 * Matches a shell command that runs bd anywhere in it, as `bd close bp-1` or `cd repo && bd update bp-1`.
 * A command that only names bd, as `grep bd notes`, matches too and costs one needless reload.
 */
const RUNS_BD = /(^|[\s;&|(])bd(\s|$)/;

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

/**
 * The guides drawn before a row under an epic, two cells for each epic above it, as in bd's own trees.
 * `branch` leads an issue with more of its epic's issues after it and `last` the final one, while `through` and `past` stand for each epic further up, with more of its issues to come or none.
 */
const GUIDES = { branch: "├ ", last: "└ ", through: "│ ", past: "  " };

/** One row of the list: an issue, the {@link GUIDES} drawn before it, and whether it is an epic outside the filter drawn only as context for its children. */
type Placed = { issue: Issue; guide: string; isContext: boolean };

/**
 * Lays `issues` out under their epics, keeping their order within each level.
 * An issue whose epic is among `issues` follows it one step deeper, led by {@link GUIDES}.
 * An issue's epic is its own `parent`, else the `parent` of its copy in `known`, since `bd blocked` leaves `parent` out.
 * An epic outside `issues` that `known` holds is drawn as context where its first child would stand, with its children under it.
 * A child whose epic is not known at all stays at the top level.
 */
function layOut(
    issues: readonly Issue[],
    known: ReadonlyMap<string, Issue>,
): Placed[] {
    const listed = new Set(issues.map((issue) => issue.id));
    const children = new Map<string, Issue[]>();
    const top: { issue: Issue; isContext: boolean }[] = [];
    for (const issue of issues) {
        const parent = issue.parent ?? known.get(issue.id)?.parent;
        const epic =
            parent === undefined
                ? undefined
                : listed.has(parent)
                  ? parent
                  : known.get(parent)?.id;
        if (epic === undefined) {
            top.push({ issue, isContext: false });
            continue;
        }
        const siblings = children.get(epic);
        if (siblings !== undefined) {
            siblings.push(issue);
            continue;
        }
        children.set(epic, [issue]);
        const context = listed.has(epic) ? undefined : known.get(epic);
        if (context !== undefined) {
            top.push({ issue: context, isContext: true });
        }
    }
    const placed: Placed[] = [];
    const place = (
        issue: Issue,
        guide: string,
        above: string,
        isContext: boolean,
    ) => {
        placed.push({ issue, guide, isContext });
        const under = children.get(issue.id) ?? [];
        under.forEach((child, index) => {
            const isLast = index === under.length - 1;
            place(
                child,
                above + (isLast ? GUIDES.last : GUIDES.branch),
                above + (isLast ? GUIDES.past : GUIDES.through),
                false,
            );
        });
    };
    for (const { issue, isContext } of top) {
        place(issue, "", "", isContext);
    }

    return placed;
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

/** The text sections of a card, in the order they are drawn, each shown only when bd has text for it. */
const TEXTS: readonly {
    /** The {@link Card} field that holds the section's markdown. */
    field: "description" | "design" | "acceptance_criteria" | "notes";
    /** The heading above the section. */
    heading: string;
}[] = [
    { field: "description", heading: "Description" },
    { field: "design", heading: "Design" },
    { field: "acceptance_criteria", heading: "Acceptance criteria" },
    { field: "notes", heading: "Notes" },
];

/** The groups of linked issues on a card, in the order they are drawn, each shown only when it has issues. */
const LINKS: readonly {
    /** The {@link Card} field that holds the group's issues. */
    field: "parent" | "depends_on" | "blocks" | "children" | "related";
    /** The heading above the group. */
    heading: string;
}[] = [
    { field: "parent", heading: "Parent" },
    { field: "depends_on", heading: "Depends on" },
    { field: "blocks", heading: "Blocks" },
    { field: "children", heading: "Children" },
    { field: "related", heading: "Related" },
];

/**
 * The line of facts atop a card: status, assignee, labels, then the creation, last change and closing days.
 * A fact bd leaves empty is left out.
 */
function factsOf(
    issue: Issue,
    card: Card,
    blocked: ReadonlySet<string>,
): string {
    const closed =
        issue.closed_at === undefined
            ? ""
            : `closed ${dayOf(issue.closed_at)}${card.close_reason === "" ? "" : `: ${card.close_reason}`}`;

    return [
        statusOf(issue, blocked).replace("_", " "),
        card.owner === "" ? "" : `owner ${card.owner}`,
        card.assignee === "" ? "" : `assignee ${card.assignee}`,
        card.labels.length === 0 ? "" : `labels ${card.labels.join(", ")}`,
        card.created_at === "" ? "" : `created ${dayOf(card.created_at)}`,
        card.updated_at === "" ? "" : `updated ${dayOf(card.updated_at)}`,
        closed,
    ]
        .filter((fact) => fact !== "")
        .join(" · ");
}

/** How many of an epic's `children` are closed, as bd's `3/10 complete (30%)`. */
function progressOf(children: readonly Issue[]): string {
    const closed = children.filter((child) => child.status === "closed").length;

    return `${closed}/${children.length} complete (${Math.round((closed / children.length) * 100)}%)`;
}

/** Width of the id column shared by every group of linked issues on `card`. */
function linkWidthOf(card: Card): number {
    return columnWidth(
        LINKS.flatMap(({ field }) => card[field]),
        (issue) => issue.id,
    );
}

/**
 * Background of an open card on the surfaces that draw one: a translucent gray that lifts the card off the pane in a dark theme and a light one alike.
 * The terminal draws the card on the pane's own background.
 */
const CARD_BACKGROUND = "#8080801A";

/** The UTC day of an ISO 8601 time, as `2026-10-28`. */
function dayOf(time: string): string {
    return time.slice(0, 10);
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

/** The prompt a card's take button drafts: the issue's id and title, and the request to claim it and read it. */
function startPrompt(issue: Issue): string {
    return `Take beads issue ${issue.id} into work: ${issue.title}\nClaim it with \`bd update ${issue.id} --claim\` and read it with \`bd show ${issue.id}\`.`;
}

/**
 * The prompt a card's close button drafts: the issue's id and title, and the request to check that its work is done, then close it with a reason.
 * The agent closes it, since only it can tell whether the work is done.
 */
function closePrompt(issue: Issue): string {
    return `Close beads issue ${issue.id}: ${issue.title}\nCheck that its work is done, then close it with \`bd close ${issue.id} --reason "<what was done>"\`. If anything is left, tell me what instead of closing it.`;
}

/**
 * The prompt the button that asks for the next issue drafts: the request to pick, of the issues `bd ready` lists, the one that fits best with the session's work, say which and why, then claim and read it.
 * The agent picks, since only it knows what the session has been doing.
 */
const NEXT_PROMPT =
    "Take the next beads issue into work: of the issues `bd ready` lists, pick the one that fits best with what this session has been doing, and tell me which and why.\nClaim it with `bd update <id> --claim` and read it with `bd show <id>`.";

/**
 * Drafts `text` in the prompt box, for the person to edit and send, and says in a toast whether the box took the request to `what`.
 * An empty box takes the draft whole, and a box holding text keeps it, with the draft after a blank line.
 */
async function draft(
    $: EngineInterface,
    text: string,
    what: string,
): Promise<void> {
    const box = await $.prompt.read();
    const filled = await $.prompt
        .fill(
            box.text.trim() === ""
                ? { text, mode: "replace" }
                : { text: `\n\n${text}`, mode: "append" },
        )
        .catch(() => ({ isFilled: false, refusal: undefined }));
    $.ui.toast(
        filled.isFilled
            ? `Drafted the request to ${what} in the prompt box`
            : `Could not draft the request to ${what}: ${FILL_FAILURES[filled.refusal ?? "refused"]}`,
    );
}

/** What the toast says for each reason the prompt box did not take a draft. */
const FILL_FAILURES: Readonly<
    Record<"no_composer" | "dialog" | "refused", string>
> = {
    no_composer: "this session has no prompt box",
    dialog: "a dialog holds the keys",
    refused: "the prompt box refused it",
};

/**
 * Registers the `/beads-pane` command and draws the beads pane.
 * The pane opens only on the command, never unasked at session start.
 * Each run of the command reads the chosen filter from bd again, then the issues in progress, the epics' progress and the other filters in the background.
 * While the pane is open, it is read again on its `Refresh` button, and at the end of each turn of the main loop and after each Bash command that runs bd when bd's database changed.
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

    on("turn.complete", async ($, e, next) => {
        const result = await next(e);
        if (e.agentId === undefined) {
            void reloadChanged($);
        }

        return result;
    });

    on("tool.call", { tool: "Bash" }, async ($, e, next) => {
        const result = await next(e);
        if (
            e.tool === "Bash" &&
            result.deny === undefined &&
            RUNS_BD.test(e.command)
        ) {
            void reloadChanged($);
        }

        return result;
    });

    on("ui.render", { component: "Pane", requestId: PANE }, async ($, e) => {
        const { Box, Button, Markdown, Text } = $.ui.resolve(e);
        const all = await read($, lists);
        const chosen = await read($, filter);
        const opened = await read($, expanded);
        const card =
            opened === null ? undefined : (await read($, cards))[opened];
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

        const counts = await read($, progress);
        const inProgress = await read($, working);
        const pinned = inProgress?.kind === "ready" ? inProgress.issues : [];
        const isPinned = new Set(pinned.map((issue) => issue.id));
        const known = new Map(
            [...Object.values(all), inProgress]
                .flatMap((load) => (load?.kind === "ready" ? load.issues : []))
                .map((issue) => [issue.id, issue]),
        );
        const issues = state?.kind === "ready" ? state.issues : [];
        const blocked = new Set(
            all.blocked?.kind === "ready"
                ? all.blocked.issues.map((issue) => issue.id)
                : [],
        );
        const placed = layOut(issues, known);
        const drawn = [...pinned, ...placed.map(({ issue }) => issue)];
        const idWidth = columnWidth(drawn, (issue) => issue.id);
        const typeWidth = columnWidth(drawn, (issue) => issue.issue_type);
        const empty =
            FILTERS.find((one) => one.filter === chosen)?.empty ?? "No issues.";

        /** The status mark and priority of `issue`, in bd's colors, both dim when it is closed or `isClosed` says so; an open epic ready to close takes {@link DONE_MARK}. */
        const drawMark = (
            issue: Issue,
            isClosed = issue.status === "closed",
        ) => {
            const isDone =
                counts[issue.id]?.isDone === true &&
                statusOf(issue, blocked) === "open";

            return (
                <Text mono dimColor={isClosed}>
                    <Text
                        color={
                            isDone
                                ? DONE_MARK.color
                                : STATUS_COLORS[statusOf(issue, blocked)]
                        }
                    >
                        {isDone ? DONE_MARK.mark : markOf(issue, blocked)}
                    </Text>{" "}
                    <Text
                        color={
                            isClosed
                                ? undefined
                                : PRIORITY_COLORS[issue.priority]
                        }
                        weight={
                            issue.priority === 0 && !isClosed
                                ? "bold"
                                : undefined
                        }
                    >
                        P{issue.priority}
                    </Text>
                </Text>
            );
        };

        /** One issue linked to the open card, in the columns of a list row: mark and priority, id, title. */
        const drawLink = (issue: Issue, idWidth: number) => (
            <Box
                key={`link-${issue.id}`}
                flexDirection="row"
                alignItems="flex-start"
            >
                <Box width={MARK_WIDTH} flexShrink={0}>
                    {drawMark(issue)}
                </Box>
                <Box width={idWidth} flexShrink={0}>
                    <Text mono dimColor>
                        {issue.id}
                    </Text>
                </Box>
                <Box flexShrink={1}>
                    <Text dimColor={issue.status === "closed"}>
                        {issue.title}
                    </Text>
                </Box>
            </Box>
        );

        /** The card of `issue`, drawn under its row while it is the open one. */
        const drawCard = (
            issue: Issue,
            load: CardLoad | undefined,
            indent: number,
        ) => (
            <Box
                key={`details-${issue.id}`}
                flexDirection="column"
                gap={1}
                marginLeft={MARK_WIDTH + indent}
                borderStyle="round"
                borderColor="subtle"
                backgroundColor={
                    e.surface === "terminal" ? undefined : CARD_BACKGROUND
                }
                paddingX={1}
            >
                {load === undefined ? (
                    <Text dimColor>Loading…</Text>
                ) : load.kind === "error" ? (
                    <Text color="error">bd failed: {load.message}</Text>
                ) : (
                    [
                        <Text key="facts" dimColor>
                            {factsOf(issue, load.card, blocked)}
                        </Text>,
                        ...(issue.status === "closed"
                            ? []
                            : [
                                  <Box
                                      key="actions"
                                      flexDirection="row"
                                      flexWrap="wrap"
                                      gap={1}
                                  >
                                      <Button
                                          key={`start-${issue.id}`}
                                          label="Ask the agent to take this issue…"
                                          hotkey="s"
                                          variant="secondary"
                                          onPress={() => {
                                              void draft(
                                                  $,
                                                  startPrompt(issue),
                                                  `start ${issue.id}`,
                                              );
                                          }}
                                      />
                                      <Button
                                          key={`close-${issue.id}`}
                                          label="Ask the agent to close this issue…"
                                          hotkey="x"
                                          variant="secondary"
                                          onPress={() => {
                                              void draft(
                                                  $,
                                                  closePrompt(issue),
                                                  `close ${issue.id}`,
                                              );
                                          }}
                                      />
                                  </Box>,
                              ]),
                        ...TEXTS.filter(
                            ({ field }) => load.card[field] !== "",
                        ).map(({ field, heading }) => (
                            <Box key={field} flexDirection="column">
                                <Text weight="bold">{heading}</Text>
                                <Markdown text={load.card[field]} />
                            </Box>
                        )),
                        ...LINKS.filter(
                            ({ field }) => load.card[field].length > 0,
                        ).map(({ field, heading }) => (
                            <Box key={field} flexDirection="column">
                                <Text weight="bold">
                                    {heading}
                                    {field === "children" ? (
                                        <Text weight="regular" dimColor>
                                            {" "}
                                            {progressOf(load.card.children)}
                                        </Text>
                                    ) : null}
                                </Text>
                                {load.card[field].map((linked) =>
                                    drawLink(linked, linkWidthOf(load.card)),
                                )}
                            </Box>
                        )),
                        ...(load.card.comments.length > 0
                            ? [
                                  <Box
                                      key="comments"
                                      flexDirection="column"
                                      gap={1}
                                  >
                                      <Text weight="bold">Comments</Text>
                                      {load.card.comments.map(
                                          (comment, index) => (
                                              <Box
                                                  key={`comment-${index}`}
                                                  flexDirection="column"
                                              >
                                                  <Text dimColor>
                                                      {comment.author} ·{" "}
                                                      {dayOf(
                                                          comment.created_at,
                                                      )}
                                                  </Text>
                                                  <Markdown
                                                      text={comment.text}
                                                  />
                                              </Box>
                                          ),
                                      )}
                                  </Box>,
                              ]
                            : []),
                    ]
                )}
            </Box>
        );

        /**
         * The row of `issue` in the columns of the list: mark and priority, id, type, title, and before the title of an epic its closed children of all, as `(7/10)`.
         * The row is led by `guide`, the tree lines that tie it to its epic, and drawn dim when it is closed or only gives context, as `isContext` says.
         * Under it comes its card while it is the open one and `hasCard` is set, so an issue pinned atop the pane draws its card there alone.
         * `prefix` keeps the keys of the pinned rows apart from the list's own.
         */
        const drawRow = (
            issue: Issue,
            prefix: string,
            hasCard: boolean,
            guide = "",
            isContext = false,
        ) => {
            const isClosed = issue.status === "closed" || isContext;
            const count = counts[issue.id];
            const indent = guide.length;

            return [
                <Box
                    key={`${prefix}issue-${issue.id}`}
                    flexDirection="row"
                    alignItems="flex-start"
                >
                    {indent === 0 ? null : (
                        <Box width={indent} flexShrink={0}>
                            <Text mono dimColor>
                                {guide}
                            </Text>
                        </Box>
                    )}
                    <Box width={MARK_WIDTH} flexShrink={0}>
                        {drawMark(issue, isClosed)}
                    </Box>
                    <Box width={idWidth} flexShrink={0}>
                        <Button
                            key={`${prefix}copy-${issue.id}`}
                            plain
                            dimColor
                            onPress={(press) => {
                                void copyId($, issue.id, press.surface);
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
                                    : (TYPE_COLORS[issue.issue_type] ??
                                      TYPE_COLOR)
                            }
                        >
                            {issue.issue_type}
                        </Text>
                    </Box>
                    <Box flexShrink={1}>
                        <Button
                            key={`${prefix}card-${issue.id}`}
                            plain
                            onPress={() => {
                                void toggle($, issue.id);
                            }}
                        >
                            <Text dimColor={isClosed}>
                                {count === undefined
                                    ? issue.title
                                    : `(${count.closed}/${count.total}) ${issue.title}`}
                            </Text>
                        </Button>
                    </Box>
                </Box>,
                ...(hasCard && opened === issue.id
                    ? [drawCard(issue, card, indent)]
                    : []),
            ];
        };

        return (
            <Box flexDirection="column" gap={1}>
                {pinned.length > 0 ? (
                    <Box
                        key="pinned"
                        flexDirection="column"
                        rowGap="xs"
                        marginBottom={1}
                    >
                        <Text weight="bold">In progress</Text>
                        {pinned.flatMap((issue) =>
                            drawRow(issue, "pinned-", true),
                        )}
                    </Box>
                ) : null}
                <Box flexDirection="row" flexWrap="wrap" gap={1}>
                    {FILTERS.map((one) => (
                        <Button
                            key={`filter-${one.filter}`}
                            label={labelOf(one.label, all[one.filter])}
                            hotkey={one.hotkey}
                            variant={
                                one.filter === chosen ? "primary" : "secondary"
                            }
                            onPress={() => {
                                void choose($, one.filter);
                            }}
                        />
                    ))}
                    <Button
                        key="refresh"
                        label="Refresh"
                        hotkey="u"
                        plain
                        dimColor
                        onPress={() => {
                            void reload($);
                        }}
                    />
                </Box>
                <Box flexDirection="row">
                    <Button
                        key="next"
                        label="Ask the agent to pick the next issue…"
                        hotkey="n"
                        plain
                        onPress={() => {
                            void draft($, NEXT_PROMPT, "take the next issue");
                        }}
                    />
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
                        {placed.flatMap(({ issue, guide, isContext }) =>
                            drawRow(
                                issue,
                                "",
                                !isPinned.has(issue.id),
                                guide,
                                isContext,
                            ),
                        )}
                    </Box>
                )}
            </Box>
        );
    });
};
