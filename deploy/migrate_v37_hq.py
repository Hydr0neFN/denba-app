# -*- coding: utf-8 -*-
"""v37 資料移轉：把「總部月租」從 rent_type（出借方式）改成 source（取得來源）。

用法:  python migrate_hq.py <db路徑> [--apply]
不加 --apply 就是 dry-run，只印出將要做的事，不寫入。
"""
import sys
import sqlite3

db_path = sys.argv[1]
APPLY = "--apply" in sys.argv

con = sqlite3.connect(db_path)
con.row_factory = sqlite3.Row
con.execute("PRAGMA foreign_keys=OFF")

def show(tag, msg):
    print(f"  [{tag}] {msg}")


# ---- 0. 確認欄位已由 server.py 的 migration 建好 -------------------------
ucols = [r[1] for r in con.execute("PRAGMA table_info(units)")]
tcols = [r[1] for r in con.execute("PRAGMA table_info(trials)")]
missing = [c for c in ("source", "hq_start", "hq_due", "hq_rent") if c not in ucols] \
    + (["trials.source"] if "source" not in tcols else [])
if missing:
    sys.exit(f"欄位還沒建立，請先用新版 server.py 開一次資料庫：{missing}")

print(f"=== {'APPLY' if APPLY else 'DRY-RUN'}  {db_path} ===\n")

# ---- 1. 賣掉的自購機 A 保持原狀 ------------------------------------------
# A（已售的自購機，成本 54000）與 B（總部月租機，貨號 DBH-J251100188）是兩台不同的
# 機器，先前擠在同一筆 unit 上。sophie 把 A 的貨號後半砍成 'DBH-' 正是為了區隔兩者。
# A 的銷售紀錄本來就是對的 → sales 完全不動，units#1 留給 A。
print("[1] 已售的自購機 A")
a = con.execute("SELECT * FROM units WHERE serial='DBH-'").fetchone()
if a:
    show("units", f"id={a['id']} '{a['serial']}' {a['status']} 成本 {a['cost']} "
                  f"→ 保持不動（source=own），貨號待 sophie 查到後補")
    for s in con.execute("SELECT * FROM sales WHERE unit_id=?", (a["id"],)):
        show("sales", f"id={s['id']} {s['date']} {s['customer']} ${s['price']} → 不動（本來就是 A 的）")
else:
    show("!!", "找不到 A（serial='DBH-'）— 略過")

# ---- 2. 另建總部月租機 B（貨號 DBH-J251100188） --------------------------
print("\n[2] 總部月租機 B")
hold = con.execute(
    "SELECT * FROM trials WHERE rent_type='hq' AND returned=0 AND customer LIKE 'DBH%'").fetchone()
if hold:
    serial_b = hold["customer"].strip()
    uid_owner = hold["user_id"]
    exists = con.execute("SELECT 1 FROM units WHERE serial=? AND user_id=?",
                         (serial_b, uid_owner)).fetchone()
    if exists:
        show("!!", f"{serial_b} 已存在，不重複建立")
    else:
        show("units", f"新建 {serial_b} {hold['model']} source=hq status=trial "
                      f"持機 {hold['start_date']}~{hold['end_date']} 標價 0 月租 0（金額待補）")
        if True:
            con.execute(
                "INSERT INTO units(serial,model,purchase_id,cost,status,note,user_id,"
                " source,hq_start,hq_due,hq_rent)"
                " VALUES(?,?,NULL,0,'trial','總部月租機',?,'hq',?,?,0)",
                (serial_b, hold["model"], uid_owner, hold["start_date"], hold["end_date"]))
    show("trials", f"id={hold['id']} 持機紀錄（非出借）→ 刪除，期間已寫進 {serial_b}")
    if True:
        con.execute("DELETE FROM trials WHERE id=?", (hold["id"],))
else:
    show("!!", "找不到 B 的持機紀錄 — 略過")

# ---- 3. 其餘 rent_type='hq'：拆成「持機」與「真出借」 --------------------
print("\n[3] 其餘 hq 紀錄")
for t in con.execute("SELECT * FROM trials WHERE rent_type='hq' ORDER BY id"):
    if not (t["customer"] or "").strip():
        show("trials", f"id={t['id']} 無客戶（{t['start_date']}~{t['end_date']}）"
                       f"＝過去持機、非出借 → 刪除")
        if True:
            con.execute("DELETE FROM trials WHERE id=?", (t["id"],))
        continue
    days = 0
    if t["start_date"] and t["end_date"]:
        import datetime
        days = (datetime.date.fromisoformat(t["end_date"])
                - datetime.date.fromisoformat(t["start_date"])).days
    rt = "week7" if 0 < days <= 10 else "month"
    show("trials", f"id={t['id']} {t['customer']} 真出借（{days}天）→ rent_type hq→{rt}, source=hq")
    if True:
        con.execute("UPDATE trials SET rent_type=?, source='hq' WHERE id=?", (rt, t["id"]))

# ---- 4. 依 note / 貨號回填其餘 trials 的 source -------------------------
print("\n[4] 依 note／貨號回填來源")
own_serials = {r["serial"] for r in con.execute("SELECT serial FROM units WHERE source='own'")}
for t in con.execute("SELECT * FROM trials WHERE source='' ORDER BY id"):
    note = t["note"] or ""
    src, why = "", ""
    if "自有" in note:
        src, why = "own", f"note「{note}」"
    elif "總部" in note:
        src, why = "hq", f"note「{note}」"
    elif (t["serial"] or "").strip() and t["serial"] in own_serials:
        src, why = "own", f"貨號 {t['serial']} 為自購機"
    if src:
        show("trials", f"id={t['id']} {t['customer'] or '—'} → source={src}（{why}）")
        if True:
            con.execute("UPDATE trials SET source=? WHERE id=?", (src, t["id"]))
    else:
        show("skip", f"id={t['id']} {t['customer'] or '—'} → 未註明（無依據，留白）")

# ---- 5. id=28 補貨號（note 明講是 188 那台） ----------------------------
print("\n[5] 補貨號")
for t in con.execute("SELECT * FROM trials WHERE note LIKE '%DBH-J251100188%' AND serial=''"):
    show("trials", f"id={t['id']} {t['customer']} → serial=DBH-J251100188（note 已註明）")
    if True:
        con.execute("UPDATE trials SET serial='DBH-J251100188' WHERE id=?", (t["id"],))

print("\n--- 移轉後 units(trial) ---")
for r in con.execute("SELECT id,serial,model,status,source,hq_start,hq_due,hq_rent,cost"
                     " FROM units WHERE status='trial' ORDER BY source DESC, id"):
    print(f"  #{r['id']:>3} {r['serial']:<17} {r['model']:<11} source={r['source']:<4}"
          f" 持機 {r['hq_start'] or '—'}~{r['hq_due'] or '—'} 月租 {r['hq_rent']} 標價 {r['cost']}")

print("\n--- 移轉後 trials ---")
for r in con.execute("SELECT id,customer,model,serial,rent_type,source,returned FROM trials ORDER BY id"):
    print(f"  #{r['id']:>3} {(r['customer'] or '—'):<14} {r['model']:<11}"
          f" {r['rent_type'] or '—':<10} source={r['source'] or '未註明':<6} 已還={r['returned']}"
          f" 貨號={r['serial'] or '—'}")

if APPLY:
    con.commit()
    print("\n=== 已寫入 ===")
else:
    con.rollback()
    print("\n=== dry-run：以上為實際執行結果，已 rollback，資料庫未變 ===")
con.close()
