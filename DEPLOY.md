# Deploy, check, record

The board is a static folder (`app/`). One rule runs through everything here: **the session token never
enters git.** `app/config.js` is gitignored; `scripts/stamp.mjs` writes it, and only the built page
carries the token — as it must, since the board calls the incident API with `?t=<session>`.

## Where it runs

| step | command |
|------|---------|
| local board | `npm run serve` → `http://localhost:4173/` |
| name the build | `npm run stamp` (local) — on GitHub Actions `deploy.yml` stamps with `$GITHUB_SHA` |
| check a live board | `npm run verify -- --url https://<board>/ [--sha <commit>]` |
| record a proof flow | `npm run record -- --url https://<board>/ --flow ack-incident` |

`verify.mjs` and `record.mjs` drive **Firefox** through `geckodriver` (WebDriver, no packages): Firefox is
the browser this workspace uses, and nothing Chromium-based runs here. Point them at the binaries with
`GECKODRIVER` / `FIREFOX` (the scripts also look in `../tools/` and the usual install paths).

## GitHub Pages

`.github/workflows/deploy.yml` builds on every push to `main`: it stamps the commit sha into
`app/index.html` (meta + footer), fills `app/config.js` from the **`BOARD_SESSION`** repository secret,
and uploads `app/`. `.github/workflows/prove.yml` is the course's file and is left exactly as shipped.

Once per repo:

```
gh repo create <you>/show-me-when-board --public
git remote add origin https://github.com/<you>/show-me-when-board.git
gh secret set BOARD_SESSION < ../session.txt          # the token travels by file, never by command line
gh api -X POST repos/<you>/show-me-when-board/pages -f build_type=workflow
git push -u origin main
```

The board then answers at `https://<you>.github.io/show-me-when-board/`. The published page embeds the
session token by design — that is what makes it a working board at a public https address — so treat
the address as the thing it is: a public page holding a session that expires on its own.

## What `verify.mjs` proves

One line per row of `plan.md`, against the page as it really runs: the http answer, https, the loader
standing before the first answer and gone after it, incidents listed newest first, one row per id, the
UTC instant on `time[datetime]` while the viewer reads their own clock, the board re-fetching on its own
(2 s cadence), `Ack` → `acked` with a receipt that survives a refresh, and the build name matching in
meta, footer and git. Last line is `result: ok` or `result: FAIL`; the full detail (incident ids,
receipts) goes to the `--out` JSON, not to the terminal.
