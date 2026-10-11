// Window navigation: the history (Back / Forward / Home) and the rules that keep
// it consistent with what the window shows while documents load asynchronously.
//
// Every navigation runs in two steps. `prepare` does everything that can fail or
// take time (reading the file, listing the folder, parsing the markdown) and
// touches neither the history nor the page. Then, if no newer navigation was
// requested meanwhile, a synchronous commit builds the new view off-page, swaps
// it in and moves the history in one go. Slow extras that come after the swap
// (Mermaid, scrolling into place) are "decorations": they belong to the view that
// was committed and stop as soon as another view replaces it.

export type NavKind = "home" | "folder" | "doc";

export interface NavEntry {
  kind: NavKind;
  /** Folder open in the window; null on a home screen once the folder is closed. */
  rootPath: string | null;
  /** Folder shown (folder view) or holding the document, relative to the root. */
  dir: string[];
  /** Document path relative to the root (doc entries only). */
  file?: string;
  /** Heading to scroll to on a fresh navigation (`page.md#anchor`). */
  anchor?: string;
  /** Where the reader was when they left this entry; restored on Back/Forward. */
  scrollTop?: number;
}

/** Where the committed view should scroll once it is in place. */
export type Positioning =
  | { mode: "anchor"; anchor: string }
  | { mode: "restore"; scrollTop: number }
  | { mode: "top" };

export interface CommitContext {
  target: NavEntry;
  positioning: Positioning;
  /** True for Back/Forward, false for a new navigation. */
  traversal: boolean;
  viewGen: number;
}

export interface DecorationContext extends CommitContext {
  /** False as soon as another view has been committed over this one. */
  isCurrent(): boolean;
}

export interface NavigatorDeps<P, B> {
  /** Async and fallible; must not touch the page. `stale()` turns true once superseded. */
  prepare(target: NavEntry, stale: () => boolean): Promise<P>;
  /** Builds the view off-page. May throw: nothing visible has changed yet. */
  build(prepared: P, ctx: CommitContext): B;
  /** Swaps the built view in. Synchronous and must not throw. */
  publish(built: B, ctx: CommitContext): void;
  /** Scroll position of the view being left, read just before the swap. */
  captureScroll(): number;
  /** Async extras for the committed view; must stop writing once `isCurrent()` is false. */
  decorate(ctx: DecorationContext): Promise<void>;
  /** A navigation failed (document unreadable…): the current view stays as it is. */
  onError(error: unknown, target: NavEntry): void;
}

export interface NavigateOptions {
  /** Explicit position for a new navigation ("Reprendre"); an anchor still wins. */
  restoreScrollTop?: number;
}

export interface NavigatorState {
  entries: readonly NavEntry[];
  index: number;
  current: NavEntry | null;
  canBack: boolean;
  canForward: boolean;
}

export const MAX_HISTORY = 100;

/** Two entries are the same place when they show the same thing; scroll does not count. */
export function sameTarget(a: NavEntry, b: NavEntry): boolean {
  return (
    a.kind === b.kind &&
    a.rootPath === b.rootPath &&
    a.dir.join("/") === b.dir.join("/") &&
    (a.file ?? null) === (b.file ?? null) &&
    (a.anchor ?? null) === (b.anchor ?? null)
  );
}

export function copyEntry(entry: NavEntry): NavEntry {
  return { ...entry, dir: [...entry.dir] };
}

/**
 * Pick the scroll position for a committed view.
 * New navigation: anchor, then an explicit restore, then the top.
 * Back/Forward: the position the reader left, then the anchor, then the top.
 */
export function resolvePositioning(
  target: NavEntry,
  traversal: boolean,
  restoreScrollTop?: number
): Positioning {
  const anchor = target.anchor ? target.anchor : undefined;
  if (traversal) {
    if (target.scrollTop !== undefined) {
      return { mode: "restore", scrollTop: target.scrollTop };
    }
    return anchor ? { mode: "anchor", anchor } : { mode: "top" };
  }
  if (anchor) return { mode: "anchor", anchor };
  if (restoreScrollTop !== undefined) {
    return { mode: "restore", scrollTop: restoreScrollTop };
  }
  return { mode: "top" };
}

type Request =
  | { kind: "push"; target: NavEntry; restoreScrollTop?: number }
  | { kind: "traverse"; index: number }
  | { kind: "initial"; target: NavEntry };

export interface Navigator {
  navigate(target: NavEntry, options?: NavigateOptions): Promise<boolean>;
  back(): Promise<boolean>;
  forward(): Promise<boolean>;
  /**
   * Reserve the startup view before anything else can navigate. Any navigation
   * requested after this call wins over the startup view.
   */
  reserveInitial(): (target: NavEntry) => Promise<boolean>;
  /** Run `task` (an export) while holding off commits; they resume afterwards. */
  runExclusive<T>(task: () => Promise<T>): Promise<T>;
  /** Settles when the current view's decorations are done. */
  decorationsDone(): Promise<void>;
  /** Patch the current entry in place (e.g. its rootPath once a folder is closed). */
  patchCurrent(patch: Partial<NavEntry>): void;
  /** Number of navigations still preparing. */
  pending(): number;
  state(): NavigatorState;
}

export function createNavigator<P, B>(deps: NavigatorDeps<P, B>): Navigator {
  let entries: NavEntry[] = [];
  let index = -1;
  // requestGen: the latest navigation asked for; only it may commit.
  // viewGen: the view on screen; only it may decorate.
  let requestGen = 0;
  let viewGen = 0;
  let inFlight = 0;
  // Target index of the Back/Forward still preparing, so two quick Backs move two steps.
  let pendingTraverse: { gen: number; index: number } | null = null;
  let exclusive: Promise<void> = Promise.resolve();
  let decorations: Promise<void> = Promise.resolve();

  function state(): NavigatorState {
    return {
      entries: entries.map(copyEntry),
      index,
      current: index >= 0 ? copyEntry(entries[index]) : null,
      canBack: index > 0,
      canForward: index >= 0 && index < entries.length - 1,
    };
  }

  function targetOf(request: Request): NavEntry {
    return request.kind === "traverse"
      ? copyEntry(entries[request.index])
      : copyEntry(request.target);
  }

  function applyHistory(request: Request, target: NavEntry, leftScroll: number): void {
    if (index >= 0) entries[index].scrollTop = leftScroll;
    if (request.kind === "traverse") {
      index = request.index;
      return;
    }
    if (request.kind === "initial") {
      entries = [target];
      index = 0;
      return;
    }
    // A fresh navigation starts with no remembered position.
    const fresh = copyEntry(target);
    delete fresh.scrollTop;
    entries = entries.slice(0, index + 1);
    entries.push(fresh);
    if (entries.length > MAX_HISTORY) {
      entries = entries.slice(entries.length - MAX_HISTORY);
    }
    index = entries.length - 1;
  }

  async function run(request: Request, gen: number): Promise<boolean> {
    const stale = () => gen !== requestGen;
    const target = targetOf(request);
    inFlight += 1;
    let prepared: P;
    try {
      prepared = await deps.prepare(copyEntry(target), stale);
    } catch (error) {
      if (!stale()) deps.onError(error, target);
      return false;
    } finally {
      inFlight -= 1;
      if (pendingTraverse && pendingTraverse.gen === gen) pendingTraverse = null;
    }

    // An export captures the page: commits wait for it, then re-check freshness.
    await exclusive;
    if (stale()) return false;

    const traversal = request.kind === "traverse";
    const positioning = resolvePositioning(
      target,
      traversal,
      request.kind === "push" ? request.restoreScrollTop : undefined
    );
    const ctx: CommitContext = { target, positioning, traversal, viewGen: gen };

    let built: B;
    try {
      built = deps.build(prepared, ctx);
    } catch (error) {
      deps.onError(error, target);
      return false;
    }

    const leftScroll = index >= 0 ? deps.captureScroll() : 0;
    applyHistory(request, target, leftScroll);
    viewGen = gen;
    deps.publish(built, ctx);

    const decoration: DecorationContext = { ...ctx, isCurrent: () => viewGen === gen };
    decorations = deps.decorate(decoration).catch((error) => {
      console.warn("Decoration failed:", error);
    });
    return true;
  }

  function request(r: Request): Promise<boolean> {
    requestGen += 1;
    pendingTraverse = null;
    return run(r, requestGen);
  }

  function traverse(step: 1 | -1): Promise<boolean> {
    const from = pendingTraverse ? pendingTraverse.index : index;
    const to = from + step;
    if (to < 0 || to >= entries.length) return Promise.resolve(false);
    requestGen += 1;
    pendingTraverse = { gen: requestGen, index: to };
    return run({ kind: "traverse", index: to }, requestGen);
  }

  return {
    navigate(target, options = {}) {
      const current = index >= 0 ? entries[index] : null;
      if (current && sameTarget(current, target) && options.restoreScrollTop === undefined) {
        // Asking for what is already on screen cancels whatever was still loading.
        if (inFlight > 0) {
          requestGen += 1;
          pendingTraverse = null;
        }
        return Promise.resolve(false);
      }
      return request({ kind: "push", target: copyEntry(target), restoreScrollTop: options.restoreScrollTop });
    },
    back: () => traverse(-1),
    forward: () => traverse(1),
    reserveInitial() {
      requestGen += 1;
      const gen = requestGen;
      return (target) => run({ kind: "initial", target: copyEntry(target) }, gen);
    },
    async runExclusive(task) {
      let release: () => void = () => {};
      const previous = exclusive;
      exclusive = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      try {
        return await task();
      } finally {
        release();
      }
    },
    decorationsDone: () => decorations,
    patchCurrent(patch) {
      if (index < 0) return;
      entries[index] = { ...entries[index], ...patch, dir: [...(patch.dir ?? entries[index].dir)] };
    },
    pending: () => inFlight,
    state,
  };
}

/**
 * Where "Y retourner" leads from a home screen that kept its folder open: the
 * latest entry of that folder before this home screen, or else the folder view.
 */
export function returnTarget(state: NavigatorState, rootPath: string): NavEntry {
  for (let i = state.index - 1; i >= 0; i--) {
    const entry = state.entries[i];
    if (entry.kind !== "home" && entry.rootPath === rootPath) return copyEntry(entry);
  }
  return { kind: "folder", rootPath, dir: [] };
}
