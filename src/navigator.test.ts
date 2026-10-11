import { describe, expect, it, vi } from "vitest";
import {
  MAX_HISTORY,
  createNavigator,
  resolvePositioning,
  returnTarget,
  sameTarget,
  type CommitContext,
  type DecorationContext,
  type NavEntry,
} from "./navigator";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const last = <T,>(list: T[]): T => list[list.length - 1];

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

const home = (rootPath: string | null = null): NavEntry => ({ kind: "home", rootPath, dir: [] });
const folder = (dir: string[] = []): NavEntry => ({ kind: "folder", rootPath: "/root", dir });
const doc = (file: string, anchor?: string): NavEntry => ({
  kind: "doc",
  rootPath: "/root",
  dir: file.split("/").slice(0, -1),
  file,
  anchor,
});

/** A fake window: prepare resolves on demand, publish records what is on screen. */
function harness() {
  const preparing = new Map<string, ReturnType<typeof deferred<string>>>();
  const shown: string[] = [];
  const published: CommitContext[] = [];
  const errors: string[] = [];
  const decorations: DecorationContext[] = [];
  let scroll = 0;
  let decorate: (ctx: DecorationContext) => Promise<void> = async (ctx) => {
    decorations.push(ctx);
  };
  const key = (e: NavEntry) => `${e.kind}:${e.file ?? e.dir.join("/")}${e.anchor ? `#${e.anchor}` : ""}`;

  const nav = createNavigator<string, string>({
    prepare(target) {
      const d = deferred<string>();
      preparing.set(key(target), d);
      return d.promise;
    },
    build(prepared) {
      if (prepared === "boom-build") throw new Error("build failed");
      return prepared;
    },
    publish(built, ctx) {
      shown.push(built);
      published.push(ctx);
    },
    captureScroll: () => scroll,
    decorate: (ctx) => decorate(ctx),
    onError(_e, target) {
      errors.push(key(target));
    },
  });

  return {
    nav,
    shown,
    published,
    errors,
    decorations,
    setScroll: (v: number) => {
      scroll = v;
    },
    setDecorate: (fn: (ctx: DecorationContext) => Promise<void>) => {
      decorate = fn;
    },
    /** Resolve the pending prepare of `entry` with `content` (defaults to its key). */
    async finish(entry: NavEntry, content?: string) {
      preparing.get(key(entry))!.resolve(content ?? key(entry));
      await flush();
    },
    async fail(entry: NavEntry) {
      preparing.get(key(entry))!.reject(new Error("unreadable"));
      await flush();
    },
  };
}

async function start(h: ReturnType<typeof harness>, entry: NavEntry = home()) {
  const p = h.nav.reserveInitial()(entry);
  await h.finish(entry);
  await p;
}

describe("sameTarget / resolvePositioning", () => {
  it("ignores the scroll position but not the anchor", () => {
    expect(sameTarget({ ...doc("a.md"), scrollTop: 10 }, doc("a.md"))).toBe(true);
    expect(sameTarget(doc("a.md", "x"), doc("a.md"))).toBe(false);
    expect(sameTarget(home("/root"), home(null))).toBe(false);
  });

  it("new navigation: anchor, then explicit restore, then top", () => {
    expect(resolvePositioning(doc("a.md", "x"), false, 300)).toEqual({ mode: "anchor", anchor: "x" });
    expect(resolvePositioning(doc("a.md"), false, 300)).toEqual({ mode: "restore", scrollTop: 300 });
    expect(resolvePositioning({ ...doc("a.md"), scrollTop: 50 }, false)).toEqual({ mode: "top" });
  });

  it("Back/Forward: the position left wins over the anchor, even at 0", () => {
    expect(resolvePositioning({ ...doc("a.md", "x"), scrollTop: 0 }, true)).toEqual({ mode: "restore", scrollTop: 0 });
    expect(resolvePositioning(doc("a.md", "x"), true)).toEqual({ mode: "anchor", anchor: "x" });
    expect(resolvePositioning(doc("a.md"), true)).toEqual({ mode: "top" });
  });
});

describe("createNavigator", () => {
  it("pushes, goes back and forward, and truncates the future on a new push", async () => {
    const h = harness();
    await start(h);
    const a = h.nav.navigate(doc("a.md"));
    await h.finish(doc("a.md"));
    expect(await a).toBe(true);
    const b = h.nav.navigate(doc("b.md"));
    await h.finish(doc("b.md"));
    await b;

    const back = h.nav.back();
    await h.finish(doc("a.md"));
    await back;
    expect(h.nav.state().current?.file).toBe("a.md");
    expect(h.nav.state().canForward).toBe(true);

    const c = h.nav.navigate(doc("c.md"));
    await h.finish(doc("c.md"));
    await c;
    expect(h.nav.state().entries.map((e) => e.file ?? e.kind)).toEqual(["home", "a.md", "c.md"]);
    expect(h.nav.state().canForward).toBe(false);
  });

  it("does not push the entry already on screen", async () => {
    const h = harness();
    await start(h, doc("a.md"));
    expect(await h.nav.navigate(doc("a.md"))).toBe(false);
    expect(h.nav.state().entries).toHaveLength(1);
  });

  it("caps the history", async () => {
    const h = harness();
    await start(h);
    for (let i = 0; i < MAX_HISTORY + 5; i++) {
      const p = h.nav.navigate(doc(`${i}.md`));
      await h.finish(doc(`${i}.md`));
      await p;
    }
    expect(h.nav.state().entries).toHaveLength(MAX_HISTORY);
    expect(h.nav.state().current?.file).toBe(`${MAX_HISTORY + 4}.md`);
  });

  it("only the latest request commits when loads finish out of order", async () => {
    const h = harness();
    await start(h);
    const a = h.nav.navigate(doc("a.md"));
    const b = h.nav.navigate(doc("b.md"));
    await h.finish(doc("b.md"));
    await h.finish(doc("a.md"));
    expect(await a).toBe(false);
    expect(await b).toBe(true);
    expect(last(h.shown)).toBe("doc:b.md");
    expect(h.nav.state().entries.map((e) => e.file ?? e.kind)).toEqual(["home", "b.md"]);
  });

  it("a failed load pushes nothing and leaves the view as it was", async () => {
    const h = harness();
    await start(h, doc("a.md"));
    const b = h.nav.navigate(doc("b.md"));
    await h.fail(doc("b.md"));
    expect(await b).toBe(false);
    expect(h.errors).toEqual(["doc:b.md"]);
    expect(h.nav.state().current?.file).toBe("a.md");
    expect(h.shown).toEqual(["doc:a.md"]);
  });

  it("a build failure is a failed navigation too", async () => {
    const h = harness();
    await start(h, doc("a.md"));
    const b = h.nav.navigate(doc("b.md"));
    await h.finish(doc("b.md"), "boom-build");
    expect(await b).toBe(false);
    expect(h.errors).toEqual(["doc:b.md"]);
    expect(h.nav.state().entries).toHaveLength(1);
  });

  it("ignores the error of a superseded request", async () => {
    const h = harness();
    await start(h);
    h.nav.navigate(doc("a.md"));
    const b = h.nav.navigate(doc("b.md"));
    await h.fail(doc("a.md"));
    await h.finish(doc("b.md"));
    await b;
    expect(h.errors).toEqual([]);
  });

  it("keeps decorating the view on screen when a newer request fails", async () => {
    const h = harness();
    await start(h, doc("a.md"));
    const ctx = last(h.decorations);
    const b = h.nav.navigate(doc("b.md"));
    await h.fail(doc("b.md"));
    await b;
    expect(ctx.isCurrent()).toBe(true);
  });

  it("stops decorating a view once another one is committed", async () => {
    const h = harness();
    await start(h, doc("a.md"));
    const ctx = last(h.decorations);
    const b = h.nav.navigate(doc("b.md"));
    await h.finish(doc("b.md"));
    await b;
    expect(ctx.isCurrent()).toBe(false);
  });

  it("two quick Backs move two steps; an impossible Back is a no-op", async () => {
    const h = harness();
    await start(h);
    for (const f of ["a.md", "b.md"]) {
      const p = h.nav.navigate(doc(f));
      await h.finish(doc(f));
      await p;
    }
    const first = h.nav.back();
    const second = h.nav.back();
    await h.finish(doc("a.md"));
    await h.finish(home());
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    expect(h.nav.state().index).toBe(0);
    expect(await h.nav.back()).toBe(false);
  });

  it("forgets a pending Back once a new navigation replaces it", async () => {
    const h = harness();
    await start(h);
    for (const f of ["a.md", "b.md"]) {
      const p = h.nav.navigate(doc(f));
      await h.finish(doc(f));
      await p;
    }
    h.nav.back();
    const c = h.nav.navigate(doc("c.md"));
    await h.finish(doc("c.md"));
    await c;
    await h.finish(doc("a.md"));
    // From c.md, Back must go to b.md, not from the abandoned target a.md.
    const back = h.nav.back();
    await h.finish(doc("b.md"));
    expect(await back).toBe(true);
    expect(h.nav.state().current?.file).toBe("b.md");
  });

  it("remembers the position left and restores it on Back", async () => {
    const h = harness();
    await start(h, doc("a.md"));
    h.setScroll(2400);
    const b = h.nav.navigate(doc("b.md"));
    await h.finish(doc("b.md"));
    await b;
    h.setScroll(0);
    const back = h.nav.back();
    await h.finish(doc("a.md"));
    await back;
    expect(last(h.published).positioning).toEqual({ mode: "restore", scrollTop: 2400 });
    expect(last(h.published).traversal).toBe(true);
  });

  it("an explicit restore is applied on a new navigation (Reprendre)", async () => {
    const h = harness();
    await start(h);
    const p = h.nav.navigate(doc("a.md"), { restoreScrollTop: 1800 });
    await h.finish(doc("a.md"));
    await p;
    expect(last(h.published).positioning).toEqual({ mode: "restore", scrollTop: 1800 });
  });

  it("a navigation requested during startup wins over the startup view", async () => {
    const h = harness();
    const commitInitial = h.nav.reserveInitial();
    const runtime = h.nav.navigate(doc("from-finder.md"));
    const initial = commitInitial(home());
    await h.finish(doc("from-finder.md"));
    await h.finish(home());
    expect(await runtime).toBe(true);
    expect(await initial).toBe(false);
    expect(h.nav.state().current?.file).toBe("from-finder.md");
  });

  it("counts navigations still preparing", async () => {
    const h = harness();
    await start(h);
    h.nav.navigate(doc("a.md"));
    h.nav.navigate(doc("b.md"));
    expect(h.nav.pending()).toBe(2);
    await h.finish(doc("a.md"));
    expect(h.nav.pending()).toBe(1);
    await h.finish(doc("b.md"));
    expect(h.nav.pending()).toBe(0);
  });

  it("holds commits during an exclusive task and releases them even if it fails", async () => {
    const h = harness();
    await start(h, doc("a.md"));
    const gate = deferred<void>();
    const exporting = h.nav.runExclusive(() => gate.promise.then(() => {
      throw new Error("export failed");
    }));
    const b = h.nav.navigate(doc("b.md"));
    await h.finish(doc("b.md"));
    expect(last(h.shown)).toBe("doc:a.md");
    gate.resolve();
    await expect(exporting).rejects.toThrow("export failed");
    expect(await b).toBe(true);
    expect(last(h.shown)).toBe("doc:b.md");
  });

  it("a request superseded while waiting for the exclusive task does not commit", async () => {
    const h = harness();
    await start(h, doc("a.md"));
    const gate = deferred<void>();
    const exporting = h.nav.runExclusive(() => gate.promise);
    const b = h.nav.navigate(doc("b.md"));
    await h.finish(doc("b.md"));
    const c = h.nav.navigate(doc("c.md"));
    await h.finish(doc("c.md"));
    gate.resolve();
    await exporting;
    expect(await b).toBe(false);
    expect(await c).toBe(true);
    expect(h.shown).toEqual(["doc:a.md", "doc:c.md"]);
  });

  it("decorationsDone follows the current view's decorations", async () => {
    const h = harness();
    const gate = deferred<void>();
    const done = vi.fn();
    h.setDecorate(() => gate.promise);
    await start(h, doc("a.md"));
    h.nav.decorationsDone().then(done);
    await flush();
    expect(done).not.toHaveBeenCalled();
    gate.resolve();
    await flush();
    expect(done).toHaveBeenCalled();
  });

  it("patchCurrent edits the entry on screen without pushing", async () => {
    const h = harness();
    await start(h, home("/root"));
    h.nav.patchCurrent({ rootPath: null });
    expect(h.nav.state().current?.rootPath).toBeNull();
    expect(h.nav.state().entries).toHaveLength(1);
  });

  it("re-asking for the view on screen cancels a load in progress", async () => {
    const h = harness();
    await start(h, doc("a.md"));
    const b = h.nav.navigate(doc("b.md"));
    await h.nav.navigate(doc("a.md"));
    await h.finish(doc("b.md"));
    expect(await b).toBe(false);
    expect(h.nav.state().current?.file).toBe("a.md");
  });

  it("a folder entry and its home keep distinct identities", async () => {
    const h = harness();
    await start(h, folder());
    const p = h.nav.navigate(home("/root"));
    await h.finish(home("/root"));
    expect(await p).toBe(true);
    expect(h.nav.state().entries.map((e) => e.kind)).toEqual(["folder", "home"]);
  });
});

describe("returnTarget", () => {
  it("leads back to the latest entry of the kept folder", async () => {
    const h = harness();
    await start(h, folder());
    for (const f of ["a.md", "b.md"]) {
      const p = h.nav.navigate(doc(f));
      await h.finish(doc(f));
      await p;
    }
    const p = h.nav.navigate(home("/root"));
    await h.finish(home("/root"));
    await p;
    expect(returnTarget(h.nav.state(), "/root").file).toBe("b.md");
  });

  it("falls back to the folder view when the history holds nothing of that folder", () => {
    const state = { entries: [home("/root")], index: 0, current: home("/root"), canBack: false, canForward: false };
    expect(returnTarget(state, "/root")).toEqual({ kind: "folder", rootPath: "/root", dir: [] });
  });
});
