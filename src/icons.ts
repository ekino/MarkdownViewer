// Stroke icons for the app's chrome (24px grid, stroke 2). One set, so the
// interface no longer mixes emoji, Unicode glyphs and SVG. Decorative: the
// control that carries one also carries its own label.

const PATHS = {
  back: '<path d="m12 19-7-7 7-7"/><path d="M19 12H5"/>',
  forward: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  folder:
    '<path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2.5h8.5A1.5 1.5 0 0 1 21 9v9.5a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5Z"/>',
  file:
    '<path d="M14 3H6.5A1.5 1.5 0 0 0 5 4.5v15A1.5 1.5 0 0 0 6.5 21h11a1.5 1.5 0 0 0 1.5-1.5V8Z"/><path d="M14 3v5h5"/>',
  readme:
    '<path d="M12 7v14"/><path d="M3 5h6a3 3 0 0 1 3 3 3 3 0 0 1 3-3h6v13h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3H3Z"/>',
  up: '<path d="m18 15-6-6-6 6"/>',
  chevrons: '<path d="m7 15 5 5 5-5"/><path d="m7 9 5-5 5 5"/>',
  chevronRight: '<path d="m9 6 6 6-6 6"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  outline: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  download: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>',
  print: '<path d="M6 9V3h12v6"/><rect x="6" y="14" width="12" height="7"/><path d="M6 18H4a1 1 0 0 1-1-1v-6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v6a1 1 0 0 1-1 1h-2"/>',
  moon: '<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  settings:
    '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  arrowRight: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  layers: '<path d="m12 3 9 5-9 5-9-5Z"/><path d="m3 13 9 5 9-5"/>',
  logout: '<path d="M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h5"/><path d="m15 8 4 4-4 4"/><path d="M19 12H9"/>',
  window: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 9h18"/>',
} as const;

export type IconName = keyof typeof PATHS;

/** SVG markup for an icon; constant strings only, never user data. */
export function icon(name: IconName, size = 16): string {
  return `<svg class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${PATHS[name]}</svg>`;
}

/** The same icon as a DOM node, ready to append. */
export function iconEl(name: IconName, size = 16): SVGElement {
  const holder = document.createElement("span");
  holder.innerHTML = icon(name, size);
  return holder.firstElementChild as SVGElement;
}

/**
 * The app's mark, drawn like the Speakino icon: a borderless yellow tile, a
 * cream key with an ink outline and hard shadow, and M↓ in rounded strokes.
 * Same geometry as src-tauri/icons/icon.svg, cropped to the tile.
 */
export function appMark(size = 64): string {
  return `<svg class="app-mark-svg" width="${size}" height="${size}" viewBox="100 100 824 824" aria-hidden="true" focusable="false"><rect x="100" y="100" width="824" height="824" rx="185" fill="#FFC629"/><rect x="268" y="262" width="520" height="520" rx="96" fill="#17130D"/><rect x="236" y="230" width="520" height="520" rx="96" fill="#FFF6DC" stroke="#17130D" stroke-width="26"/><g fill="none" stroke="#17130D" stroke-width="44" stroke-linecap="round" stroke-linejoin="round"><path d="M318 590V380l86 120 86-120v210"/><path d="M610 380v210M556 536l54 54 54-54"/></g></svg>`;
}
