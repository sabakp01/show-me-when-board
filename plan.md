# sched-prod incident board — plan

The on-call board for sched-prod. One page, one list: tonight's incidents, newest first, so on-call sees
what just broke and takes it.

## Flows

| flow | who | what happens |
|------|-----|--------------|
| `open-board` | on-call | opens the board; sees tonight's incidents |
| `ack-incident` | on-call | picks an incident on the board and acks it — "I've got this one" |
| `watch-board` | on-call | keeps the board open; it stays current without a reload |

## Requirements

- **R1** New incidents appear live at the top of the list, newest first. (Re-affirmed by product, 2026-11-14T20:52:10Z: "New incidents stay live at the top".)
- **R2** Each incident row has an **Ack** button. Ack does not ack: it opens a confirm **inside that row**, and the confirm names the incident id. Only `confirm-ack` sends the ack (`api.ack(id)`) and marks the row acked; `confirm-cancel` (or Escape) closes the ask and the row keeps offering Ack. The Ack and its ask stay on the row — they are children of the row, so they travel with it when the list moves, and the ack can only ever commit the id the person read.
- **R3** Show a loader until incidents load.
- **R4** The board refreshes itself every 2 seconds while open.
- **R5** Times show in the viewer's local time; day before month for EU locales (dd/mm).
- **R6** The page names its build: `<meta name="build" content="<git sha>">` in the head and the same sha in the footer.

## Hooks (pinned — tests and the replay rely on them)

| `data-testid` | element |
|---------------|---------|
| `board` | the board's main area |
| `loader` | the loader (gone once incidents load) |
| `empty` | what shows when there are no incidents |
| `incident-list` | the list |
| `incident-row` | one incident row, with `data-id="<incident id>"` |
| `ack` | the Ack button in a row |
| `confirm` | the ask a row shows after its Ack is clicked; its text names the incident id |
| `confirm-ack` | the control in that ask that sends the ack, labelled with the same id |
| `confirm-cancel` | the control in that ask that closes it and sends nothing |
| `acked` | the acked mark in a row |
| `build-sha` | the sha in the footer |

## Product's decision (answered 2026-11-14T20:52:10.349Z)

Product watched the step-1 recording (the ack race at 00:08) and decided:

> New incidents stay live at the top and Ack stays on the row, but Ack asks to confirm, and the confirm
> names the incident id. — product

That is the task for this build, and it is what `plan.md` R1–R2 above now says.

### What this replaces

| value | as it stood | as it stands now | who | when |
|-------|-------------|------------------|-----|------|
| R2, the Ack's effect | "Ack sends the ack (`api.ack(id)`) and marks the row acked." | Ack opens a confirm naming the id; only `confirm-ack` sends it | proposed and approved by product ("Ack asks to confirm"), implementation mine | 2026-11-14T20:52:10.349Z |
| Hooks | `ack`, `acked` | plus `confirm`, `confirm-ack`, `confirm-cancel` | product named the three hooks in the same answer | 2026-11-14T20:52:10.349Z |
| R1 (order) | newest first, live | unchanged — product re-affirmed it | product | 2026-11-14T20:52:10.349Z |
| R3–R6 | loader, 2 s refresh, local times, named build | unchanged by this decision | — | — |

Nothing else in the plan moved: the flow list, the other hooks, and the Done section stand as written.

## System Diff

What moved in the system between the build on-call watched in the step-1 recording and the build that
answers it. In that recording the hand rested on `INC-3403`'s Ack at 945,181; `INC-4544` was inserted at
20:35:01.560, the button went down 49 ms later at the same spot, `INC-3403` had slid 45 px down out from
under the pointer, and the receipt came back on `INC-3856`. One row below for each value that moved;
anything not listed is exactly as that build left it.

| part | before | after | who decided | where it shows |
|------|--------|-------|-------------|----------------|
| what a press on Ack does | sent `api.ack(id)`; the row came back acked on the next refresh | changes only that row's own state: it opens an ask standing where the Ack was | product, 2026-11-14T20:52:10.349Z | R2; replay `d` (nothing is acked until you commit); the take's frames between the press and the receipt |
| what the row says about the press | nothing — the row never named the incident the press would take | the ask says it in words, and the button says it again: `Ack INC-4544?` for the row `INC-4544` | product ("the confirm names the incident id") | R2; replay `x`; `verify` check 2 (the ask's own text must contain that row's id) |
| who commits the ack | the pointer's coordinates, read against whichever row happened to sit under them | a second, deliberate press on that row's `confirm-ack`, which commits the id the row holds — never a coordinate | product | R2; the take's `confirmAck` (its own rectangle, read after the ask opened) |
| getting out | there was no way out | `confirm-cancel`, or Escape, closes the ask; the row keeps offering Ack and no request was ever made | product named the control; the Escape key is my addition | replay `j`; `verify` checks 5 and 6; the take's `afterCancel` (Ack back, no receipt) |
| an open ask across a refresh | n/a | the ask is rebuilt from the row's own state, so a refresh that reorders the list keeps it open on the same row | mine, to keep the decision honest while the board moves | `verify` check 4 |
| where the control lives | the Ack sat in the row | unchanged: the ask is built inside that row's own `.act` cell, so a row that slides carries its open ask with it | — | R2's last sentence |
| list order, cadence, loader, empty state, times, build name | newest first, live; 2 s refresh; loader; empty; local dd/mm; `<meta name="build">` + footer sha | unchanged | product re-affirmed R1 | replay `a`, `g`, `h`, `i`, `y`; R1, R3–R6 |
| test hooks | `board loader empty incident-list incident-row ack acked build-sha` | the same, plus `confirm`, `confirm-ack`, `confirm-cancel` | product named all three in the same answer | Hooks table |

## Done


Every issue in `issues/` delivered, deployed to a public https address, and shown working.
