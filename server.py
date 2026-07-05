#!/usr/bin/env python3
# DENBA Max 進銷存 — single-file webapp (Flask + SQLite + waitress)
import datetime
import io
import json
import os
import re
import secrets
import sqlite3
import sys
import time
from functools import wraps

from flask import Flask, g, jsonify, request, send_file, session

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH", os.path.join(BASE, "denba.db"))
PORT = int(os.environ.get("PORT", "2026"))
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.config.update(
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_HTTPONLY=True,
    PERMANENT_SESSION_LIFETIME=datetime.timedelta(days=60),
)

SCHEMA = """
CREATE TABLE IF NOT EXISTS purchases(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  model TEXT NOT NULL,
  qty INTEGER NOT NULL,
  total INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS units(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serial TEXT NOT NULL UNIQUE,
  model TEXT NOT NULL,
  purchase_id INTEGER,
  cost INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_stock',
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS sales(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  customer TEXT NOT NULL,
  unit_id INTEGER,
  model TEXT NOT NULL,
  serial TEXT NOT NULL DEFAULT '',
  price INTEGER NOT NULL,
  card_fee INTEGER NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL,
  warranty_no TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS trials(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer TEXT NOT NULL,
  model TEXT NOT NULL,
  start_date TEXT NOT NULL DEFAULT '',
  end_date TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  returned INTEGER NOT NULL DEFAULT 0
);
"""

UNIT_STATUSES = ("in_stock", "sold", "trial", "retired")


def init_db():
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    cols = [r[1] for r in con.execute("PRAGMA table_info(sales)")]
    if "warranty_no" not in cols:
        con.execute("ALTER TABLE sales ADD COLUMN warranty_no TEXT NOT NULL DEFAULT ''")
    empty = all(
        con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] == 0
        for t in ("purchases", "units", "sales", "trials")
    )
    seed_path = os.path.join(BASE, "seed_data.json")
    if empty and os.path.exists(seed_path):
        with open(seed_path, encoding="utf-8") as f:
            seed = json.load(f)
        for p in seed.get("purchases", []):
            con.execute(
                "INSERT INTO purchases(date,model,qty,total,note) VALUES(?,?,?,?,?)",
                (p["date"], p["model"], p["qty"], p["total"], p.get("note", "")),
            )
        for u in seed.get("units", []):
            con.execute(
                "INSERT INTO units(serial,model,purchase_id,cost,status,note) VALUES(?,?,NULL,?,?,?)",
                (u["serial"], u["model"], u["cost"], u["status"], u.get("note", "")),
            )
        for s in seed.get("sales", []):
            con.execute(
                "INSERT INTO sales(date,customer,unit_id,model,serial,price,card_fee,cost,note)"
                " VALUES(?,?,NULL,?,?,?,?,?,?)",
                (s["date"], s["customer"], s["model"], s.get("serial", ""),
                 s["price"], s.get("card_fee", 0), s["cost"], s.get("note", "")),
            )
        for t in seed.get("trials", []):
            con.execute(
                "INSERT INTO trials(customer,model,start_date,end_date,note,returned) VALUES(?,?,?,?,?,?)",
                (t.get("customer", ""), t.get("model", ""), t.get("start_date", ""),
                 t.get("end_date", ""), t.get("note", ""), t.get("returned", 0)),
            )
        con.commit()
    con.close()


def db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH)
        g.db.row_factory = sqlite3.Row
    return g.db


@app.teardown_appcontext
def close_db(_exc):
    con = g.pop("db", None)
    if con is not None:
        con.close()


def auth_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get("auth"):
            return jsonify(error="unauthorized"), 401
        return f(*args, **kwargs)
    return wrapper


def bad(msg, code=400):
    return jsonify(error=msg), code


def as_int(v, default=0):
    try:
        return int(round(float(v)))
    except (TypeError, ValueError):
        return default


# ---------- pages ----------

@app.route("/")
def index():
    return app.send_static_file("index.html")


@app.route("/sw.js")
def sw():
    return app.send_static_file("sw.js")


# ---------- auth ----------

@app.route("/api/login", methods=["POST"])
def login():
    pw = (request.get_json(silent=True) or {}).get("password", "")
    if APP_PASSWORD and secrets.compare_digest(pw, APP_PASSWORD):
        session.permanent = True
        session["auth"] = True
        return jsonify(ok=True)
    time.sleep(0.6)
    return bad("密碼錯誤", 401)


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify(ok=True)


# ---------- data ----------

MONTHLY_SQL = """
SELECT substr(date,1,7) AS ym,
       SUM(price - card_fee) AS revenue,
       SUM(cost) AS cost,
       SUM(price - card_fee) - SUM(cost) AS profit,
       COUNT(*) AS qty
FROM sales GROUP BY ym ORDER BY ym
"""


@app.route("/api/data")
@auth_required
def data():
    con = db()
    return jsonify(
        units=[dict(r) for r in con.execute("SELECT * FROM units ORDER BY model, serial")],
        purchases=[dict(r) for r in con.execute("SELECT * FROM purchases ORDER BY date DESC, id DESC")],
        sales=[dict(r) for r in con.execute("SELECT * FROM sales ORDER BY date DESC, id DESC")],
        trials=[dict(r) for r in con.execute("SELECT * FROM trials ORDER BY returned, start_date DESC, id DESC")],
        monthly=[dict(r) for r in con.execute(MONTHLY_SQL)],
        customers=[r[0] for r in con.execute(
            "SELECT DISTINCT customer FROM sales WHERE customer<>'' ORDER BY customer")],
    )


# ---------- purchases ----------

@app.route("/api/purchase", methods=["POST"])
@auth_required
def add_purchase():
    d = request.get_json(silent=True) or {}
    date, model = (d.get("date") or "").strip(), (d.get("model") or "").strip()
    total = as_int(d.get("total"), -1)
    serials = [s.strip() for s in d.get("serials", []) if s and s.strip()]
    status = d.get("status", "in_stock")
    if not date or not model or total < 0 or not serials:
        return bad("日期、型號、金額、貨號皆為必填")
    if status not in ("in_stock", "trial"):
        return bad("入庫類型不正確")
    if len(set(serials)) != len(serials):
        return bad("貨號重複")
    con = db()
    exists = [s for s in serials
              if con.execute("SELECT 1 FROM units WHERE serial=?", (s,)).fetchone()]
    if exists:
        return bad("貨號已存在：" + "、".join(exists))
    n = len(serials)
    base_cost = total // n
    cur = con.execute(
        "INSERT INTO purchases(date,model,qty,total,note) VALUES(?,?,?,?,?)",
        (date, model, n, total, d.get("note", "")),
    )
    pid = cur.lastrowid
    for i, s in enumerate(serials):
        cost = total - base_cost * (n - 1) if i == 0 else base_cost
        con.execute(
            "INSERT INTO units(serial,model,purchase_id,cost,status) VALUES(?,?,?,?,?)",
            (s, model, pid, cost, status),
        )
    con.commit()
    return jsonify(ok=True, id=pid)


@app.route("/api/purchase/<int:pid>", methods=["PATCH"])
@auth_required
def edit_purchase(pid):
    d = request.get_json(silent=True) or {}
    con = db()
    p = con.execute("SELECT * FROM purchases WHERE id=?", (pid,)).fetchone()
    if not p:
        return bad("找不到此筆進貨", 404)
    date = (d.get("date") or p["date"]).strip()
    model = (d.get("model") or p["model"]).strip()
    total = as_int(d.get("total", p["total"]), p["total"])
    note = d.get("note", p["note"])
    if not date or not model or total < 0:
        return bad("日期、型號、金額皆為必填")
    con.execute(
        "UPDATE purchases SET date=?, model=?, total=?, note=? WHERE id=?",
        (date, model, total, note, pid),
    )
    if total != p["total"]:
        unit_ids = [r["id"] for r in con.execute(
            "SELECT id FROM units WHERE purchase_id=? ORDER BY id", (pid,))]
        n = len(unit_ids)
        if n:
            base = total // n
            for i, uid in enumerate(unit_ids):
                cost = total - base * (n - 1) if i == 0 else base
                con.execute("UPDATE units SET cost=? WHERE id=?", (cost, uid))
    con.commit()
    return jsonify(ok=True)


@app.route("/api/purchase/<int:pid>", methods=["DELETE"])
@auth_required
def del_purchase(pid):
    con = db()
    sold = con.execute(
        "SELECT COUNT(*) FROM units WHERE purchase_id=? AND status='sold'", (pid,)
    ).fetchone()[0]
    if sold:
        return bad("此筆進貨已有機器售出，無法刪除")
    con.execute("DELETE FROM units WHERE purchase_id=?", (pid,))
    con.execute("DELETE FROM purchases WHERE id=?", (pid,))
    con.commit()
    return jsonify(ok=True)


# ---------- sales ----------

@app.route("/api/sale", methods=["POST"])
@auth_required
def add_sale():
    d = request.get_json(silent=True) or {}
    date = (d.get("date") or "").strip()
    customer = (d.get("customer") or "").strip()
    unit_ids = d.get("unit_ids") or []
    total_price = as_int(d.get("total_price"), -1)
    card_fee = as_int(d.get("card_fee"), 0)
    warranty = (d.get("warranty_no") or "").strip()
    fixes = d.get("serial_fix") or {}
    note = d.get("note", "")
    if not date or not customer or not unit_ids or total_price < 0:
        return bad("日期、客戶、貨號、金額皆為必填")
    con = db()
    units = [con.execute("SELECT * FROM units WHERE id=?", (uid,)).fetchone() for uid in unit_ids]
    if any(u is None for u in units):
        return bad("找不到指定的機器")
    not_avail = [u["serial"] for u in units if u["status"] != "in_stock"]
    if not_avail:
        return bad("非在庫（已售／試用機／除役）：" + "、".join(not_avail))
    n = len(units)
    base = total_price // n
    for i, u in enumerate(units):
        price = total_price - base * (n - 1) if i == 0 else base
        serial = (fixes.get(str(u["id"])) or "").strip() or u["serial"]
        if serial != u["serial"]:
            if con.execute("SELECT 1 FROM units WHERE serial=? AND id<>?", (serial, u["id"])).fetchone():
                return bad("貨號已存在：" + serial)
            con.execute("UPDATE units SET serial=? WHERE id=?", (serial, u["id"]))
        con.execute(
            "INSERT INTO sales(date,customer,unit_id,model,serial,price,card_fee,cost,warranty_no,note)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (date, customer, u["id"], u["model"], serial, price,
             card_fee if i == 0 else 0, u["cost"], warranty, note),
        )
        con.execute("UPDATE units SET status='sold' WHERE id=?", (u["id"],))
    con.commit()
    return jsonify(ok=True)


@app.route("/api/sale/<int:sid>", methods=["PATCH"])
@auth_required
def edit_sale(sid):
    d = request.get_json(silent=True) or {}
    con = db()
    s = con.execute("SELECT * FROM sales WHERE id=?", (sid,)).fetchone()
    if not s:
        return bad("找不到此筆銷售", 404)
    date = (d.get("date") or s["date"]).strip()
    customer = (d.get("customer") or s["customer"]).strip()
    model = (d.get("model") or s["model"]).strip()
    serial = (d["serial"] if "serial" in d else s["serial"]).strip()
    price = as_int(d.get("price", s["price"]), s["price"])
    card_fee = as_int(d.get("card_fee", s["card_fee"]), s["card_fee"])
    cost = as_int(d.get("cost", s["cost"]), s["cost"])
    warranty = (d["warranty_no"] if "warranty_no" in d else s["warranty_no"]).strip()
    note = d.get("note", s["note"])
    if not date or not customer or price < 0 or card_fee < 0 or cost < 0:
        return bad("日期、客戶、金額皆為必填")
    if s["unit_id"]:
        if not serial:
            return bad("此筆已連結機器，貨號不可空白")
        if serial != s["serial"]:
            if con.execute("SELECT 1 FROM units WHERE serial=? AND id<>?", (serial, s["unit_id"])).fetchone():
                return bad("貨號已存在")
            con.execute("UPDATE units SET serial=? WHERE id=?", (serial, s["unit_id"]))
    con.execute(
        "UPDATE sales SET date=?, customer=?, model=?, serial=?, price=?, card_fee=?,"
        " cost=?, warranty_no=?, note=? WHERE id=?",
        (date, customer, model, serial, price, card_fee, cost, warranty, note, sid),
    )
    con.commit()
    return jsonify(ok=True)


@app.route("/api/sale/<int:sid>", methods=["DELETE"])
@auth_required
def del_sale(sid):
    con = db()
    row = con.execute("SELECT * FROM sales WHERE id=?", (sid,)).fetchone()
    if not row:
        return bad("找不到此筆銷售", 404)
    if row["unit_id"]:
        con.execute("UPDATE units SET status='in_stock' WHERE id=? AND status='sold'", (row["unit_id"],))
    con.execute("DELETE FROM sales WHERE id=?", (sid,))
    con.commit()
    return jsonify(ok=True)


# ---------- trials ----------

@app.route("/api/trial", methods=["POST"])
@auth_required
def add_trial():
    d = request.get_json(silent=True) or {}
    customer = (d.get("customer") or "").strip()
    if not customer:
        return bad("請填寫人名")
    con = db()
    con.execute(
        "INSERT INTO trials(customer,model,start_date,end_date,note) VALUES(?,?,?,?,?)",
        (customer, d.get("model", ""), d.get("start_date", ""), d.get("end_date", ""), d.get("note", "")),
    )
    con.commit()
    return jsonify(ok=True)


@app.route("/api/trial/<int:tid>/return", methods=["POST"])
@auth_required
def return_trial(tid):
    con = db()
    con.execute("UPDATE trials SET returned=1 WHERE id=?", (tid,))
    con.commit()
    return jsonify(ok=True)


@app.route("/api/trial/<int:tid>", methods=["PATCH"])
@auth_required
def edit_trial(tid):
    d = request.get_json(silent=True) or {}
    con = db()
    t = con.execute("SELECT * FROM trials WHERE id=?", (tid,)).fetchone()
    if not t:
        return bad("找不到此筆試用", 404)
    customer = (d["customer"] if "customer" in d else t["customer"]).strip()
    model = (d["model"] if "model" in d else t["model"]).strip()
    start = (d["start_date"] if "start_date" in d else t["start_date"]).strip()
    end = (d["end_date"] if "end_date" in d else t["end_date"]).strip()
    note = d.get("note", t["note"])
    returned = 1 if d.get("returned", t["returned"]) else 0
    con.execute(
        "UPDATE trials SET customer=?, model=?, start_date=?, end_date=?, note=?, returned=? WHERE id=?",
        (customer, model, start, end, note, returned, tid),
    )
    con.commit()
    return jsonify(ok=True)


@app.route("/api/trial/<int:tid>", methods=["DELETE"])
@auth_required
def del_trial(tid):
    con = db()
    con.execute("DELETE FROM trials WHERE id=?", (tid,))
    con.commit()
    return jsonify(ok=True)


# ---------- units ----------

@app.route("/api/unit/<int:uid>", methods=["PATCH"])
@auth_required
def edit_unit(uid):
    d = request.get_json(silent=True) or {}
    con = db()
    u = con.execute("SELECT * FROM units WHERE id=?", (uid,)).fetchone()
    if not u:
        return bad("找不到機器", 404)
    serial = (d.get("serial") or u["serial"]).strip()
    note = d.get("note", u["note"])
    cost = as_int(d.get("cost", u["cost"]), u["cost"])
    status = d.get("status", u["status"])
    if status not in UNIT_STATUSES:
        return bad("狀態不正確")
    if u["status"] == "sold" and status != "sold":
        return bad("已售出的機器請先刪除該筆銷售")
    if u["status"] != "sold" and status == "sold":
        return bad("請用「銷售」登記售出")
    dup = con.execute("SELECT 1 FROM units WHERE serial=? AND id<>?", (serial, uid)).fetchone()
    if dup:
        return bad("貨號已存在")
    con.execute(
        "UPDATE units SET serial=?, note=?, cost=?, status=? WHERE id=?",
        (serial, note, cost, status, uid),
    )
    con.execute("UPDATE sales SET serial=? WHERE unit_id=?", (serial, uid))
    con.commit()
    return jsonify(ok=True)


# ---------- export ----------

def build_workbook(con):
    from openpyxl import Workbook
    from openpyxl.styles import Alignment, Font, PatternFill
    from openpyxl.utils import get_column_letter

    wb = Workbook()
    head_font = Font(bold=True, color="FFFFFF")
    head_fill = PatternFill("solid", start_color="3B4A9F")
    money = "#,##0"

    def style_head(ws, ncols, widths):
        for c in range(1, ncols + 1):
            cell = ws.cell(row=1, column=c)
            cell.font = head_font
            cell.fill = head_fill
            cell.alignment = Alignment(horizontal="center")
        for i, w in enumerate(widths, 1):
            ws.column_dimensions[get_column_letter(i)].width = w

    ws = wb.active
    ws.title = "月報"
    ws.append(["月份", "銷售總額", "銷貨成本", "毛利", "銷售數量", "毛利率"])
    rows = list(con.execute(MONTHLY_SQL))
    for r in rows:
        ws.append([r["ym"], r["revenue"], r["cost"], r["profit"], r["qty"],
                   (r["profit"] / r["revenue"]) if r["revenue"] else 0])
    if rows:
        tr = sum(r["revenue"] for r in rows)
        tc = sum(r["cost"] for r in rows)
        tq = sum(r["qty"] for r in rows)
        ws.append(["合計", tr, tc, tr - tc, tq, ((tr - tc) / tr) if tr else 0])
        ws.cell(row=len(rows) + 2, column=1).font = Font(bold=True)
    for row in ws.iter_rows(min_row=2, min_col=2, max_col=4):
        for cell in row:
            cell.number_format = money
    for row in ws.iter_rows(min_row=2, min_col=6, max_col=6):
        for cell in row:
            cell.number_format = "0.0%"
    style_head(ws, 6, [10, 12, 12, 12, 10, 9])

    ws = wb.create_sheet("銷售明細")
    ws.append(["日期", "客戶", "型號", "貨號", "保證書編號", "銷售單價", "刷卡費", "實收", "進貨成本", "毛利", "備註"])
    for s in con.execute("SELECT * FROM sales ORDER BY date, id"):
        net = s["price"] - s["card_fee"]
        ws.append([s["date"], s["customer"], s["model"], s["serial"], s["warranty_no"],
                   s["price"], s["card_fee"], net, s["cost"], net - s["cost"], s["note"]])
    for row in ws.iter_rows(min_row=2, min_col=6, max_col=10):
        for cell in row:
            cell.number_format = money
    style_head(ws, 11, [11, 12, 11, 12, 13, 11, 9, 11, 11, 11, 28])

    ws = wb.create_sheet("進貨明細")
    ws.append(["日期", "型號", "數量", "金額", "備註"])
    for p in con.execute("SELECT * FROM purchases ORDER BY date, id"):
        ws.append([p["date"], p["model"], p["qty"], p["total"], p["note"]])
    for row in ws.iter_rows(min_row=2, min_col=4, max_col=4):
        for cell in row:
            cell.number_format = money
    style_head(ws, 5, [11, 24, 8, 12, 36])

    ws = wb.create_sheet("庫存")
    ws.append(["貨號", "型號", "狀態", "成本", "備註"])
    label = {"in_stock": "在庫", "sold": "已售", "trial": "試用機", "retired": "除役"}
    for u in con.execute("SELECT * FROM units ORDER BY status, model, serial"):
        ws.append([u["serial"], u["model"], label.get(u["status"], u["status"]), u["cost"], u["note"]])
    for row in ws.iter_rows(min_row=2, min_col=4, max_col=4):
        for cell in row:
            cell.number_format = money
    style_head(ws, 5, [14, 12, 9, 11, 32])

    ws = wb.create_sheet("試用出租")
    ws.append(["人名", "型號", "開始", "結束", "狀態", "備註"])
    for t in con.execute("SELECT * FROM trials ORDER BY returned, start_date"):
        ws.append([t["customer"], t["model"], t["start_date"], t["end_date"],
                   "已歸還" if t["returned"] else "進行中", t["note"]])
    style_head(ws, 6, [12, 11, 11, 11, 9, 28])

    return wb


@app.route("/api/export.xlsx")
@auth_required
def export_xlsx():
    wb = build_workbook(db())
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    name = "DENBA_進銷存_" + datetime.date.today().strftime("%Y%m%d") + ".xlsx"
    return send_file(
        buf,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        as_attachment=True,
        download_name=name,
    )


# ---------- backups / restore ----------

BACKUP_DIR = os.environ.get("BACKUP_DIR", os.path.join(os.path.dirname(DB_PATH), "backups"))
BACKUP_NAME_RE = re.compile(r"^denba-(\d{8}|pre-restore-\d{8}-\d{6})\.db$")


def snapshot_db(dest_path):
    src = sqlite3.connect(DB_PATH)
    dst = sqlite3.connect(dest_path)
    src.backup(dst)
    dst.close()
    src.close()


@app.route("/api/backups")
@auth_required
def list_backups():
    os.makedirs(BACKUP_DIR, exist_ok=True)
    out = []
    for fn in os.listdir(BACKUP_DIR):
        if BACKUP_NAME_RE.match(fn):
            st = os.stat(os.path.join(BACKUP_DIR, fn))
            out.append({"name": fn, "size": st.st_size, "mtime": int(st.st_mtime)})
    out.sort(key=lambda x: (x["mtime"], x["name"]), reverse=True)
    return jsonify(backups=out)


@app.route("/api/backup-now", methods=["POST"])
@auth_required
def backup_now():
    os.makedirs(BACKUP_DIR, exist_ok=True)
    name = "denba-" + datetime.date.today().strftime("%Y%m%d") + ".db"
    snapshot_db(os.path.join(BACKUP_DIR, name))
    try:
        con = sqlite3.connect(DB_PATH)
        con.row_factory = sqlite3.Row
        build_workbook(con).save(os.path.join(BACKUP_DIR, "DENBA_進銷存_latest.xlsx"))
        con.close()
    except Exception:
        pass
    return jsonify(ok=True, name=name)


@app.route("/api/restore", methods=["POST"])
@auth_required
def restore_backup():
    name = (request.get_json(silent=True) or {}).get("name", "")
    if not BACKUP_NAME_RE.match(name):
        return bad("備份檔名不正確")
    path = os.path.join(BACKUP_DIR, name)
    if not os.path.exists(path):
        return bad("找不到備份檔", 404)
    pre = "denba-pre-restore-" + datetime.datetime.now().strftime("%Y%m%d-%H%M%S") + ".db"
    snapshot_db(os.path.join(BACKUP_DIR, pre))
    src = sqlite3.connect(path)
    dst = sqlite3.connect(DB_PATH)
    src.backup(dst)
    dst.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    dst.close()
    src.close()
    pres = sorted(f for f in os.listdir(BACKUP_DIR) if f.startswith("denba-pre-restore-"))
    for f in pres[:-10]:
        os.unlink(os.path.join(BACKUP_DIR, f))
    return jsonify(ok=True, pre_restore=pre)


init_db()

if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "export":
        cli_con = sqlite3.connect(DB_PATH)
        cli_con.row_factory = sqlite3.Row
        build_workbook(cli_con).save(sys.argv[2])
        cli_con.close()
    else:
        if not APP_PASSWORD:
            raise SystemExit("APP_PASSWORD 未設定（請在 denba.env 設定）")
        from waitress import serve
        serve(app, host="0.0.0.0", port=PORT, threads=4)
