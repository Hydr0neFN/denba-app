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

# ---- 1. sales#95：金額真實，但機器綁錯 → 解除機器連結 --------------------
print("[1] 錯誤的銷售連結")
for s in con.execute("SELECT * FROM sales WHERE unit_id IS NOT NULL AND serial IN ('DBH-','')"):
    show("sales", f"id={s['id']} {s['date']} {s['customer']} {s['model']} "
                  f"${s['price']} → unit_id {s['unit_id']}→NULL, serial ''（金額不動）")
    if True:
        con.execute("UPDATE sales SET unit_id=NULL, serial='' WHERE id=?", (s["id"],))

# ---- 2. units#1 → 還原成 DBH-J251100188 的總部月租機 ---------------------
print("\n[2] 188 這台機器")
hold = con.execute(
    "SELECT * FROM trials WHERE rent_type='hq' AND returned=0 AND customer LIKE 'DBH%'").fetchone()
u1 = con.execute("SELECT * FROM units WHERE serial='DBH-' OR serial='DBH-J251100188'").fetchone()
if hold and u1:
    show("units", f"id={u1['id']} serial '{u1['serial']}'→'{hold['customer']}', "
                  f"status '{u1['status']}'→trial, source→hq, "
                  f"持機 {hold['start_date']}~{hold['end_date']}, cost {u1['cost']} 保留為總部標價")
    if True:
        con.execute(
            "UPDATE units SET serial=?, status='trial', source='hq', hq_start=?, hq_due=?,"
            " note='總部月租機' WHERE id=?",
            (hold["customer"], hold["start_date"], hold["end_date"], u1["id"]))
    show("trials", f"id={hold['id']} 持機紀錄（非出借）→ 刪除，期間已寫進 units#{u1['id']}")
    if True:
        con.execute("DELETE FROM trials WHERE id=?", (hold["id"],))
else:
    show("!!", f"找不到對應資料 hold={bool(hold)} unit={bool(u1)} — 略過")

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
