// macOS "Use Selection for Find" (⌘E): collapsed, whitespace-only, or
// outside-the-document selections become no-ops rather than clearing the bar.
export function readSelectionWithin(
  container: HTMLElement,
  sel: Selection | null
): string {
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
    return "";
  }
  const range = sel.getRangeAt(0);
  if (!container.contains(range.commonAncestorContainer)) {
    return "";
  }
  return sel.toString().trim();
}
