# DENBA 進銷存
<img width="2360" height="1640" alt="IMG_0563" src="https://github.com/user-attachments/assets/87725227-007c-4037-9d5a-b3b7e0d6a6ae" />

<img width="2360" height="1640" alt="IMG_0564" src="https://github.com/user-attachments/assets/fc778c29-99c0-4af6-a6cb-aceb271373c7" />

iPad-first PWA for a small device business selling **DENBA** electric-field machines — tracks 進貨 (purchases), 銷售 (sales), 試用 (trials/rentals), live 庫存 (inventory), and monthly P&L. Replaced a formula-heavy Excel workbook (進銷存 xlsx) in July 2026.

Single-file **Flask + SQLite + waitress** backend, vanilla-JS PWA frontend, **zero build step**. Runs happily on a Raspberry Pi behind a Cloudflare Tunnel.

## Features

- **進貨** — register a purchase: date, one or more model blocks (each with its own qty, amount, and one 貨號 (serial) per machine — a mixed-model invoice becomes one row per model in a single atomic save), an 一般庫存/試用機 toggle, and an auto-serial generator; the edit modal lists every machine of the purchase with in-place serial editing (atomic, swap-safe, synced into sale history), and legacy ledger-only rows (Excel imports without linked machines) support editable qty plus one-tap 拆單 into per-model rows
- **銷售** — pick in-stock machines by 貨號 (cost auto-looked-up), enter total price (auto-split across units), optional 刷卡手續費 / 保證書編號; 毛利 previewed live before saving; real serial can be typed/corrected at sale time. Two categories: **一般銷售**, or **居間特許** (salesman-brokered deals) which tracks the 保證金 deposit and 佣金 commission separately, auto-splitting the government withholdings (預扣稅款 10% + 二代健保補充保費 2.11%) and a one-tap 結清 (settle) status; a monthly 特許金流 cash-flow table (deposit-in / refund-out / net payout) is shown alongside 月報 and exported as its own Excel sheet. **特許領機** (consignment) records machines a 特許 has taken against a deposit before any sale — the machine shows as 特許機 in 庫存, the held deposit counts in 特許金流, and a one-tap 售出 converts it into a prefilled 居間特許 sale; a sale's category can also be re-toggled after the fact (for legacy rows entered before this feature). Every sale takes an optional **其他費用** (amount + free-text name, e.g. 調貨/開發票) expensed in 月報; the 佣金比例 is adjustable per deal (保證金%＋佣金%＝100%, floor 12.11% because the withholdings come out of the commission), with 保證金/佣金/預扣稅款/補充保費 auto-filled from the price and hand-editable
- **試用** — trial/rental log with days-remaining badges and 歸還 (return) button; rentals are categorized 七天租/月租 (direct), 特許租用 (franchise, monthly), and 總部月租 (a machine borrowed from HQ for the month and sub-rented at her discretion), each grouped in its own section with type badges; the form auto-fills the end date (+7 or +30 days) per category
- **庫存** — *derived* inventory: purchased − sold, per model, with per-unit status (在庫/試用機/特許機/已售/除役) and inline editing
- **月報** — monthly revenue/cost/profit/margin table + bar chart
- **報稅匯出** — one-click **執行業務所得印領清冊** (`GET /api/tax-export.xlsx?year=YYYY`, or a year-picker card at the bottom of 月報): fills the accountant's blank `tax_template.xlsx` in place so 標楷體/borders/print-layout match the official 範本 byte-for-byte, writing only the ROC-year title, 特許人 names, and per-month settled-payout figures (佣金/扣繳稅額 10%/補充保費 2.11%/實領). Data = settled 居間特許 payouts keyed by 結清日; 身份證號/地址/扶養人數/前期佣金 left blank for the owner to hand-fill. Unlike the main export this sheet keeps SUM **formulas** (the accountant edits it in Excel)
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
tax_template.xlsx accountant's blank 執行業務所得印領清冊 form (no personal data); filled in place by 報稅匯出
denba.db          SQLite (created on first run; seeded from seed_data.json if present and DB empty)
deploy/           systemd unit, daily backup cron script, OneDrive pull script (Windows), env example
```

Tables: `purchases`, `units` (one row per machine, cost + status live here), `sales` (denormalized model/serial, with 居間特許 deposit/commission/withholding columns), `trials` (categorized by `rent_type`), `consignments` (特許領機 — a machine a 特許 holds against a deposit before any sale). Inventory is derived from `units.status` — there is no separately maintained stock count.

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
