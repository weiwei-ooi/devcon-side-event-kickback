# Truth Pays: public pages (GitHub Pages)

Built from `main` (do not edit here: change the source on `main`, rebuild, and copy the result in).

| Path | What | Built with |
|---|---|---|
| `/deposit/` (and `/` for older links) | Truth Pays guest deposit page, contract 0xd5c6…677D baked in | `node scripts/build-site.mjs --out <dir>` |
| `/organiser/` | Organiser panel with the Truth Pays event preloaded | `node scripts/build-admin.mjs --out <dir> --guest-page ../deposit/` |
| `/admin/` | Organiser panel for any event (opens the event in its link) | `node scripts/build-admin.mjs --out <dir> --no-default-event` |
| `/event/` | Guest deposit page for any event (`?contract=0x…&from=<block>`) | `node scripts/build-site.mjs --generic --out <dir>` |

The builds refuse an output folder inside a baked site, so build elsewhere and copy into these folders.
