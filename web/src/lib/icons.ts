// Inline SVG path data for the app's icon set. Every icon is drawn on a
// 24x24 grid, stroke-based (currentColor), so a single <Icon> component can
// render any of them consistently. Keep new icons in this same minimal,
// rounded-stroke style.
export const ICONS: Record<string, string> = {
  folder: '<path d="M3 6.2A2.2 2.2 0 0 1 5.2 4h3.6l2 2H19a2.2 2.2 0 0 1 2.2 2.2v9.6A2.2 2.2 0 0 1 19 20H5.2A2.2 2.2 0 0 1 3 17.8V6.2z"/>',
  'arrow-up': '<path d="M12 19V5"/><path d="M6 11l6-6 6 6"/>',
  image: '<rect x="3" y="4" width="18" height="16" rx="2.2"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="M21 16.5l-5.2-5.2-4 4-3-3L3 17.5"/>',
  paperclip: '<path d="M17.3 7.4l-8.1 8.1a2.9 2.9 0 1 0 4.1 4.1l7.6-7.6a5.1 5.1 0 1 0-7.2-7.2l-7.6 7.6a7.3 7.3 0 1 0 10.3 10.3"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.2 5.7"/><path d="M20 5.2V11h-5.8"/>',
  x: '<path d="M18 6L6 18"/><path d="M6 6l12 12"/>',
  plus: '<path d="M12 5v14"/><path d="M5 12h14"/>',
  star: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 16.9l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3z"/>',
  'star-filled': '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 16.9l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9L12 3z"/>',
  grid: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.4"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.4"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.4"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.4"/>',
  'git-branch': '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="8.5" r="2"/><path d="M6 7v10"/><path d="M6 12.5a5.5 5.5 0 0 0 5.5 5.5H16"/><path d="M18 10.5v-2"/>',
  sun: '<circle cx="12" cy="12" r="4.4"/><path d="M12 2.5v2.4"/><path d="M12 19.1v2.4"/><path d="M4.3 4.3l1.7 1.7"/><path d="M18 18l1.7 1.7"/><path d="M2.5 12h2.4"/><path d="M19.1 12h2.4"/><path d="M4.3 19.7l1.7-1.7"/><path d="M18 6l1.7-1.7"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.9 2.9l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6V21a2 2 0 0 1-4 0v-.1A1.7 1.7 0 0 0 8.7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.9-2.9l.1-.1A1.7 1.7 0 0 0 4.2 15a1.7 1.7 0 0 0-1.6-1H2.5a2 2 0 0 1 0-4h.1A1.7 1.7 0 0 0 4.2 8.7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.9-2.9l.1.1A1.7 1.7 0 0 0 8.7 4.2a1.7 1.7 0 0 0 1-1.6V2.5a2 2 0 0 1 4 0v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.9 2.9l-.1.1A1.7 1.7 0 0 0 19.8 8.7a1.7 1.7 0 0 0 1.6 1h.1a2 2 0 0 1 0 4h-.1a1.7 1.7 0 0 0-1.6 1.3z"/>',
  'corner-down-left': '<polyline points="9.5 10 4.5 15 9.5 20"/><path d="M19.5 4v7a4 4 0 0 1-4 4H4.5"/>',
  play: '<polygon points="5.5 3.5 19.5 12 5.5 20.5 5.5 3.5"/>',
};
