# DENBA 進銷存

iPad-first PWA for a small device business selling **DENBA Max** electric-field machines — tracks 進貨 (purchases), 銷售 (sales), 試用 (trials/rentals), live 庫存 (inventory), and monthly P&L. Replaced a formula-heavy Excel workbook (進銷存 xlsx) in July 2026.

Single-file **Flask + SQLite + waitress** backend, vanilla-JS PWA frontend, **zero build step**. Runs happily on a Raspberry Pi behind a Cloudflare Tunnel.

## Features

- **進貨** — register a purchase: date, model, total amount, one 貨號 (serial) per machine, with an 一般庫存/試用機 toggle and auto-serial generator
- **銷售** — pick in-stock machines by 貨號 (cost auto-looked-up), enter total price (auto-split across units), optional 刷卡手續費 / 保證書編號; 毛利 previewed live before saving; real serial can be typed/corrected at sale time. Two categories: **一般銷售**, or **居間特許** (salesman-brokered deals) which tracks the 保證金 deposit and 佣金 commission separately, auto-splitting the government withholdings (預扣稅款 10% + 二代健保補充保費 2.11%) and a one-tap 結清 (settle) status; a monthly 特許金流 cash-flow table (deposit-in / refund-out / net payout) is shown alongside 月報 and exported as its own Excel sheet. **特許領機** (consignment) records machines a 特許 has taken against a deposit before any sale — the machine shows as 特許機 in 庫存, the held deposit counts in 特許金流, and a one-tap 售出 converts it into a prefilled 居間特許 sale; a sale's category can also be re-toggled after the fact (for legacy rows entered before this feature)
- **試用** — trial/rental log with days-remaining badges and 歸還 (return) button
- **庫存** — *derived* inventory: purchased − sold, per model, with per-unit status (在庫/試用機/特許機/已售/除役) and inline editing
- **月報** — monthly revenue/cost/profit/margin table + bar chart
- **Excel export** — one click, 5-sheet workbook (values, not formulas, so iPad QuickLook renders correctly)
- Multi-user accounts (hashed passwords, 60-day sessions) with **full per-user data isolation** — each user has their own records, inventory, serial namespace, reports, and Excel export
- Admin panel: create/manage users (一般/管理員 roles, promote/demote, password reset, delete with auto data snapshot)
- Two-layer backups: per-user snapshots anyone can restore (own data only) + whole-DB snapshots for admins
- PWA installable to iPad home screen
- On iOS, use built-in **掃描文字 (Scan Text)** in any 貨號 field to OCR serial labels

## Architecture

```
static/           vanilla JS PWA (index.html, app.js, style.css, sw.js, manifest)
server.py         Flask app: auth, JSON API, xlsx export (also CLI: python server.py export out.xlsx)
denba.db          SQLite (created on first run; seeded from seed_data.json if present and DB empty)
deploy/           systemd unit, daily backup cron script, OneDrive pull script (Windows), env example
```

Tables: `purchases`, `units` (one row per machine, cost + status live here), `sales` (denormalized model/serial), `trials`. Inventory is derived from `units.status` — there is no separately maintained stock count.

## Quick start

```bash
python -m venv venv
venv/bin/pip install -r requirements.txt
cp deploy/denba.env.example denba.env   # set APP_USER / APP_PASSWORD / SECRET_KEY
set -a; . ./denba.env; set +a
python server.py                        # → http://localhost:2026
```

On first run, `APP_USER`/`APP_PASSWORD` become the bootstrap admin account; after that, users are managed in-app (⚙️ → 使用者管理).

## Production deployment

Deployed on a Raspberry Pi 4 (Debian, aarch64) at `/opt/denba`, run by systemd (`deploy/denba.service`), exposed via Cloudflare Tunnel (`http://localhost:2026`). Nightly cron makes a 30-day rotating `.db` snapshot **plus** a fresh xlsx; a Windows scheduled task pulls both into OneDrive. The detailed operational runbook is maintained privately outside this repo.

## Notes

- `seed_data.json` (real customer/financial data) is intentionally **not committed** — see `seed_data.example.json` for the format. The app runs fine without it (starts empty).
- `deploy/denba.env` (secrets) is git-ignored; use the `.example` template.
- Recommended: put Cloudflare Access in front of the public hostname as a second auth layer.
