# HANDOFF — DENBA 進銷存 knowledge document

Everything a future maintainer (human or AI) needs. Written 2026-07-04 after v7.

## 1. What this is

Web replacement for `DENBA_電場進銷存_2026.xlsx`. The business sells DENBA Max electric-field machines in Taiwan. Models: **High Grade** (~$94,000 cost), **Standard** (~$54,000), **Charge** (~$44,000), plus **Pet** (rental-only so far). VAT/發票 handling is deliberately **out of scope** — the accountant does tax; the app's Excel export is the handoff artifact.

## 2. Production environment

| Thing | Value |
|---|---|
| Host | Raspberry Pi 4, Debian 13 aarch64 (also runs other services and cloudflared) |
| LAN | `<pi-ip>` (SSH as root, key-based) |
| App dir | `/opt/denba` (server.py, static/, venv/, denba.db, denba.env, backups/) |
| Service | `systemctl {status,restart} denba` — waitress on **port 2026**, auto-restart, boot-enabled |
| Public URL | `<your-tunnel-hostname>` → Cloudflare Tunnel → `http://localhost:2026` |
| Secrets | `/opt/denba/denba.env` (PORT, APP_PASSWORD, SECRET_KEY, DB_PATH), chmod 600 |
| Logs | `journalctl -u denba -e` |

Dev copy of the source lives on the owner's Windows PC (this repo).

## 3. Data model & invariants

```
purchases(id, date, model, qty, total, note)
units(id, serial UNIQUE, model, purchase_id, cost, status, note)   status: in_stock|sold|trial|retired
sales(id, date, customer, unit_id, model, serial, price, card_fee, cost, warranty_no, note)
trials(id, customer, model, start_date, end_date, note, returned)
```

Rules the code enforces (don't break them):

- **Machines enter only via 進貨** (`POST /api/purchase`) — creates the ledger row *and* one `units` row per serial. Per-unit cost = total ÷ n, remainder on the first unit. The 單機入庫 path was removed on purpose (owner: "we always pay to import").
- **Inventory is derived** — never stored. Stock = `units` with `status='in_stock'`; 試用機 = `status='trial'`.
- **Sales take a TOTAL price** (`total_price`) and split it across selected units (remainder → first row). `card_fee` also sits on the first row only. Revenue = Σ(price − card_fee).
- Only `in_stock` units are sellable (UI *and* server reject others). To sell a demo unit: flip it to 在庫 in 庫存 first.
- `serial_fix` in the sale payload renames a unit at sale time (legacy workflow: real 貨號 often only read off the box when sold). Cost is untouched by renames — it lives on the unit row.
- `sales` denormalizes `model`/`serial`/`cost` so history survives unit edits and the Excel-era import rows (which have `unit_id NULL`).
- Deleting a sale returns its unit to `in_stock`. Deleting a purchase is blocked if any of its units sold.
- Sales are editable in place (tap the card → `PATCH /api/sale/<id>`): all row fields including cost; a serial change on a unit-linked sale renames the unit too (dup-checked); serial cannot be blanked on linked rows. Editing `price` edits *that row's* share of a multi-unit sale.
- Purchases are editable in place (`PATCH /api/purchase/<id>`): date/model/total/note only — qty/serials are structural (edit serials per-unit in 庫存; structural change = delete & re-enter, blocked once sold). Changing `total` re-splits cost across ALL that purchase's units (remainder → first), but **sold sales keep their historical cost** — fix those individually via sale edit if intended.
- Trials are editable in place (`PATCH /api/trial/<id>`) including the returned flag (un-return possible); model may be '' (未定) for waitlist rows.
- Monthly report groups by `substr(date,1,7)`; margins computed from net revenue.

## 4. History / seeded data

- 2026 H1 history was imported from the xlsx: 18 sale rows (`unit_id NULL`, note tagged "Excel匯入"), 6 purchase ledger rows, 12 trial rows.
- The 16 opening-stock units got **invented placeholder serials** (`ST-01`, `CH-01`…`CH-07`, `HG-01/02`, `*-T1/T2` for 試用機) — the xlsx never tracked serials. Real serials look like **`DBH-J2511100189`** (white sticker on box). Owner replaces placeholders via 庫存 edit or the sale-time 貨號更正 field.
- `seed_data.json` only loads when ALL four tables are empty (first boot). Production DB is past that point; the file matters only for rebuilds.

## 5. Backup chain (verified working)

1. **Pi, cron.daily** (`/etc/cron.daily/denba-backup`): SQLite `.backup` → `/opt/denba/backups/denba-YYYYMMDD.db` (keeps 30) + regenerates `DENBA_進銷存_latest.xlsx` via `venv/bin/python server.py export <path>` (CLI mode, no auth needed).
2. **Windows PC, Task Scheduler** `DENBA-Backup-Pull` (daily 21:00, StartWhenAvailable): runs `deploy/pull-backup.ps1` → `scp root@<pi-ip>:/opt/denba/backups/* "%OneDrive%\DENBA-Backup"`.
3. **OneDrive** syncs to cloud (version history on the xlsx).

**Restore**: `systemctl stop denba` → copy chosen `denba-YYYYMMDD.db` over `/opt/denba/denba.db` → `systemctl start denba`.

## 6. Runbook

| Task | How |
|---|---|
| Redeploy after code change | `scp server.py root@<pi-ip>:/opt/denba/ ; scp static/* root@<pi-ip>:/opt/denba/static/ ; ssh root@<pi-ip> 'python3 -m py_compile /opt/denba/server.py && systemctl restart denba'` — bump `V` in `sw.js` whenever static files change |
| Change app password | edit `APP_PASSWORD` in `/opt/denba/denba.env` → `systemctl restart denba` |
| Add/rename a model | `MODELS` + `PREFIX` constants in `static/app.js` (server stores model as free text) |
| Manual xlsx | ⬇ Excel button in app header, or `venv/bin/python server.py export /tmp/out.xlsx` on the Pi |
| Serial OCR for staff | iOS built-in: tap 貨號 field → 掃描文字 (do NOT re-add server OCR, see §7) |

## 7. Gotchas learned the hard way

- **PowerShell 5.1 + scheduled tasks**: BOM-less UTF-8 `.ps1` files are read as ANSI → Chinese strings mojibake; `$env:OneDrive` may be unset in task context. `pull-backup.ps1` is therefore pure ASCII with an `HKCU:\Environment` fallback. Keep it that way.
- **Git Bash on Windows mangles UTF-8 in inline `curl -d` JSON** → always `--data-binary @file.json` when testing with Chinese payloads.
- **iPad QuickLook does not recalculate xlsx formulas** → the export writes computed *values*, not formulas. Don't "improve" it back to formulas.
- **Server-side camera OCR was built (tesseract) and removed in v7** — high failure rate on real box labels vs. Apple's Live Text. Not worth re-adding.
- **tesseract `--psm 11` misses sticker labels; `--psm 3` worked** (kept for posterity should OCR return).
- Multi-model sales in one transaction: enter as separate sales — the split logic assumes one total across the selected units and does not weight by model.
- Use a strong `APP_PASSWORD` that is **not reused** from any OS/system account, and put Cloudflare Access (email OTP) in front of the public hostname — the app is a single shared password with only a soft delay on failures.

## 8. Decision log (condensed)

| v | Decision |
|---|---|
| v1 | DB (SQLite) as source of truth, Excel demoted to export. Port 2026. Flask+waitress, no build step. |
| v2 | Per-unit 貨號; sale-time serial correction (`serial_fix`); 保證書編號 field; sale form defaults to 全部 units; FAB → menu. |
| v3 | 進貨 gets 一般庫存/試用機 toggle; auto-serials `-T` suffix for trials. |
| v4 | Sale price = TOTAL (split server-side); 試用機 excluded from sellable pool (UI + API). |
| v5 | 單機入庫 removed — 進貨 is the only way machines enter. |
| v6 | Backup chain to OneDrive; `server.py export` CLI; (camera OCR added). |
| v7 | Camera OCR removed; staff use iOS 掃描文字. |
| v8 | Sales click-to-edit (fix legacy import mistakes + future typos without delete/re-enter). |
| v9 | Trials click-to-edit too (all fields + 進行中/已歸還 toggle, so a mis-tapped 歸還 is reversible). |
| v10 | Purchases click-to-edit (date/model/total/note; total re-splits unit costs, sold sales' cost frozen). All four record types now editable in place. |
