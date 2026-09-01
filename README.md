# Buoy

Private, minimal Firefox desktop RSS reader. Buoy reads RSS, Atom, and OPML locally in Firefox. No account, analytics, or cloud sync.

## Features

- Add remote feed URLs or import `.rss`, `.xml`, `.atom`, and `.opml` files.
- Bulk migrate subscriptions through standard OPML import and export.
- Refresh URL feeds every 15 minutes and retain latest 200 posts per feed.
- Rebuild the feed cache from the Manage feeds dialog: force fresh downloads for every remote feed, replace each feed's cached posts with the current response, and preserve read state for matching posts.
- Open full reader from toolbar or use Firefox sidebar.
- Inline plain-text previews, read state, and per-feed optional notifications.
- Local IndexedDB storage and safe HTTP(S)-only feed links/media.
- System light/dark styling, keyboard focus states, and reduced-motion support.

Imported files without a feed self-link become local snapshots. OPML imports and exports remote subscription URLs; local snapshots, cached posts, read state, and notification preferences stay in Buoy.

## Development

```bash
npm install
npm run test
npm run build
npm run lint
```

Load `dist/manifest.json` from `about:debugging#/runtime/this-firefox` for manual testing.

```bash
npm run dev
```

`npm run dev` rebuilds on changes. `npm run package` creates a ZIP in `web-ext-artifacts/`.
