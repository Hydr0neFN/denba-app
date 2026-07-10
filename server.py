#!/usr/bin/env python3
# DENBA Max 進銷存 — single-file webapp (Flask + SQLite + waitress), multi-user
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
from werkzeug.security import check_password_hash, generate_password_hash

BASE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.environ.get("DB_PATH", os.path.join(BASE, "denba.db"))
PORT = int(os.environ.get("PORT", "2026"))
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")   # bootstrap admin password (first run only)
APP_USER = os.environ.get("APP_USER", "admin")      # bootstrap admin username (first run only)
BACKUP_DIR = os.environ.get("BACKUP_DIR", os.path.join(os.path.dirname(DB_PATH), "backups"))

app = Flask(__name__, static_folder="static", static_url_path="/static")
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)
app.config.update(
    SESSION_COOKIE_SAMESITE="Lax",
    SESSION_COOKIE_HTTPONLY=True,
    PERMANENT_SESSION_LIFETIME=datetime.timedelta(days=60),
    MAX_CONTENT_LENGTH=1024 * 1024,
)


@app.after_request
def security_headers(resp):
    resp.headers.setdefault("X-Content-Type-Options", "nosniff")
    resp.headers.setdefault("X-Frame-Options", "DENY")
    resp.headers.setdefault("Referrer-Policy", "same-origin")
    if request.path.startswith("/api/"):
        resp.headers["Cache-Control"] = "no-store"
    return resp


@app.before_request
def limit_field_lengths():
    if request.method in ("POST", "PATCH") and request.path.startswith("/api/"):
        d = request.get_json(silent=True)
        if isinstance(d, dict):
            for v in d.values():
                vals = v if isinstance(v, list) else v.values() if isinstance(v, dict) else [v]
                for x in vals:
                    if isinstance(x, str) and len(x) > 1000:
                        return bad("欄位長度過長")

SCHEMA = """
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS purchases(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  model TEXT NOT NULL,
  qty INTEGER NOT NULL,
  total INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS units(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  serial TEXT NOT NULL,
  model TEXT NOT NULL,
  purchase_id INTEGER,
  cost INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'in_stock',
  note TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL DEFAULT 1
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
  note TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL DEFAULT 1,
  sale_type TEXT NOT NULL DEFAULT 'normal',
  agent TEXT NOT NULL DEFAULT '',
  deposit INTEGER NOT NULL DEFAULT 0,
  deposit_date TEXT NOT NULL DEFAULT '',
  commission INTEGER NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0,
  health_fee INTEGER NOT NULL DEFAULT 0,
  settled INTEGER NOT NULL DEFAULT 0,
  settle_date TEXT NOT NULL DEFAULT '',
  extra_fee INTEGER NOT NULL DEFAULT 0,
  extra_label TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS trials(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer TEXT NOT NULL,
  model TEXT NOT NULL,
  start_date TEXT NOT NULL DEFAULT '',
  end_date TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  returned INTEGER NOT NULL DEFAULT 0,
  user_id INTEGER NOT NULL DEFAULT 1,
  rent_type TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS consignments(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent TEXT NOT NULL,
  unit_id INTEGER,
  deposit INTEGER NOT NULL DEFAULT 0,
  deposit_date TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  user_id INTEGER NOT NULL DEFAULT 1,
  returned INTEGER NOT NULL DEFAULT 0,
  refund_date TEXT NOT NULL DEFAULT '',
  refund_amount INTEGER NOT NULL DEFAULT 0
);
"""

UNIT_STATUSES = ("in_stock", "sold", "trial", "retired", "consigned")
RENT_TYPES = ("week7", "month", "franchise", "hq")
DATA_TABLES = ("purchases", "units", "sales", "trials", "consignments")
USERNAME_RE = re.compile(r"^[A-Za-z0-9_.-]{2,20}$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
WITHHOLD_RATE = 0.10   # 預扣稅款
HEALTH_RATE = 0.0211   # 二代健保補充保費


def valid_date(s):
    if not DATE_RE.match(s):
        return False
    try:
        datetime.date.fromisoformat(s)
    except ValueError:
        return False
    return True


def half_up(x):
    return int(x + 0.5)   # Taiwan 四捨五入 — Python round() is banker's rounding, don't use it here


def next_month_15(date_s):
    d = datetime.date.fromisoformat(date_s)
    y, m = (d.year + 1, 1) if d.month == 12 else (d.year, d.month + 1)
    return f"{y:04d}-{m:02d}-15"


def init_db():
    con = sqlite3.connect(DB_PATH)
    con.execute("PRAGMA journal_mode=WAL")
    con.executescript(SCHEMA)
    cols = [r[1] for r in con.execute("PRAGMA table_info(sales)")]
    if "warranty_no" not in cols:
        con.execute("ALTER TABLE sales ADD COLUMN warranty_no TEXT NOT NULL DEFAULT ''")
    franchise_cols = {
        "sale_type": "TEXT NOT NULL DEFAULT 'normal'",
        "agent": "TEXT NOT NULL DEFAULT ''",
        "deposit": "INTEGER NOT NULL DEFAULT 0",
        "deposit_date": "TEXT NOT NULL DEFAULT ''",
        "commission": "INTEGER NOT NULL DEFAULT 0",
        "tax": "INTEGER NOT NULL DEFAULT 0",
        "health_fee": "INTEGER NOT NULL DEFAULT 0",
        "settled": "INTEGER NOT NULL DEFAULT 0",
        "settle_date": "TEXT NOT NULL DEFAULT ''",
        "extra_fee": "INTEGER NOT NULL DEFAULT 0",
        "extra_label": "TEXT NOT NULL DEFAULT ''",
    }
    for col, ddl in franchise_cols.items():
        if col not in cols:
            con.execute(f"ALTER TABLE sales ADD COLUMN {col} {ddl}")
    ccols = [r[1] for r in con.execute("PRAGMA table_info(consignments)")]
    consign_cols = {
        "returned": "INTEGER NOT NULL DEFAULT 0",
        "refund_date": "TEXT NOT NULL DEFAULT ''",
        "refund_amount": "INTEGER NOT NULL DEFAULT 0",
    }
    for col, ddl in consign_cols.items():
        if col not in ccols:
            con.execute(f"ALTER TABLE consignments ADD COLUMN {col} {ddl}")
    tcols = [r[1] for r in con.execute("PRAGMA table_info(trials)")]
    if "rent_type" not in tcols:
        con.execute("ALTER TABLE trials ADD COLUMN rent_type TEXT NOT NULL DEFAULT ''")
    ucols = [r[1] for r in con.execute("PRAGMA table_info(users)")]
    if "token_ver" not in ucols:
        con.execute("ALTER TABLE users ADD COLUMN token_ver INTEGER NOT NULL DEFAULT 0")
    # multi-user migration: add user_id to legacy tables (existing rows → user 1)
    for t in DATA_TABLES:
        tcols = [r[1] for r in con.execute(f"PRAGMA table_info({t})")]
        if "user_id" not in tcols:
            con.execute(f"ALTER TABLE {t} ADD COLUMN user_id INTEGER NOT NULL DEFAULT 1")
    # legacy units had a global UNIQUE(serial); rebuild so serials are unique per user
    units_sql = con.execute(
        "SELECT sql FROM sqlite_master WHERE type='table' AND name='units'").fetchone()[0]
    if "UNIQUE" in units_sql.upper():
        con.executescript("""
            CREATE TABLE units_mu(
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              serial TEXT NOT NULL,
              model TEXT NOT NULL,
              purchase_id INTEGER,
              cost INTEGER NOT NULL,
              status TEXT NOT NULL DEFAULT 'in_stock',
              note TEXT NOT NULL DEFAULT '',
              user_id INTEGER NOT NULL DEFAULT 1
            );
            INSERT INTO units_mu(id,serial,model,purchase_id,cost,status,note,user_id)
              SELECT id,serial,model,purchase_id,cost,status,note,user_id FROM units;
            DROP TABLE units;
            ALTER TABLE units_mu RENAME TO units;
        """)
    con.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_units_user_serial ON units(user_id, serial)")
    # bootstrap admin on first run
    if con.execute("SELECT COUNT(*) FROM users").fetchone()[0] == 0 and APP_PASSWORD:
        con.execute(
            "INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,1)",
            (APP_USER, generate_password_hash(APP_PASSWORD)),
        )
    empty = all(
        con.execute(f"SELECT COUNT(*) FROM {t}").fetchone()[0] == 0 for t in DATA_TABLES
    )
    seed_path = os.path.join(BASE, "seed_data.json")
    if empty and os.path.exists(seed_path):
        with open(seed_path, encoding="utf-8") as f:
            seed = json.load(f)
        for p in seed.get("purchases", []):
            con.execute(
                "INSERT INTO purchases(date,model,qty,total,note,user_id) VALUES(?,?,?,?,?,1)",
                (p["date"], p["model"], p["qty"], p["total"], p.get("note", "")),
            )
        for u in seed.get("units", []):
            con.execute(
                "INSERT INTO units(serial,model,purchase_id,cost,status,note,user_id)"
                " VALUES(?,?,NULL,?,?,?,1)",
                (u["serial"], u["model"], u["cost"], u["status"], u.get("note", "")),
            )
        for s in seed.get("sales", []):
            con.execute(
                "INSERT INTO sales(date,customer,unit_id,model,serial,price,card_fee,cost,note,user_id)"
                " VALUES(?,?,NULL,?,?,?,?,?,?,1)",
                (s["date"], s["customer"], s["model"], s.get("serial", ""),
                 s["price"], s.get("card_fee", 0), s["cost"], s.get("note", "")),
            )
        for t in seed.get("trials", []):
            con.execute(
                "INSERT INTO trials(customer,model,start_date,end_date,note,returned,user_id)"
                " VALUES(?,?,?,?,?,?,1)",
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
        uid = session.get("uid")
        if not uid:
            return jsonify(error="unauthorized"), 401
        user = db().execute("SELECT * FROM users WHERE id=?", (uid,)).fetchone()
        if not user or session.get("tv", 0) != user["token_ver"]:
            session.clear()
            return jsonify(error="unauthorized"), 401
        g.user = user
        return f(*args, **kwargs)
    return wrapper


def admin_required(f):
    @wraps(f)
    @auth_required
    def wrapper(*args, **kwargs):
        if not g.user["is_admin"]:
            return jsonify(error="需要管理員權限"), 403
        return f(*args, **kwargs)
    return wrapper


def bad(msg, code=400):
    return jsonify(error=msg), code


def as_int(v, default=0):
    try:
        return int(round(float(v)))
    except (TypeError, ValueError, OverflowError):
        return default


# ---------- pages ----------

@app.route("/")
def index():
    return app.send_static_file("index.html")


@app.route("/sw.js")
def sw():
    return app.send_static_file("sw.js")


# ---------- auth ----------

# login rate limiting: per-IP and per-username failure lockout (in-memory)
LOGIN_FAILS = {}          # key -> (count, first_fail_ts, locked_until_ts)
IP_LIMIT, USER_LIMIT = 10, 20
LOCK_SECS = 900
FAIL_WINDOW = 900
DUMMY_HASH = generate_password_hash("timing-equalizer")


def client_ip():
    return (request.headers.get("CF-Connecting-IP")
            or request.headers.get("X-Forwarded-For", "").split(",")[0].strip()
            or request.remote_addr or "?")


def login_locked(keys):
    now = time.time()
    for k in list(LOGIN_FAILS):
        c, first, locked = LOGIN_FAILS[k]
        if locked < now and now - first > FAIL_WINDOW:
            LOGIN_FAILS.pop(k, None)
    for k in keys:
        rec = LOGIN_FAILS.get(k)
        if rec and rec[2] > now:
            return int(rec[2] - now)
    return 0


def login_failed(keys):
    now = time.time()
    for k in keys:
        limit = IP_LIMIT if k.startswith("ip:") else USER_LIMIT
        c, first, locked = LOGIN_FAILS.get(k, (0, now, 0.0))
        if now - first > FAIL_WINDOW:
            c, first = 0, now
        c += 1
        if c >= limit:
            locked = now + LOCK_SECS
        LOGIN_FAILS[k] = (c, first, locked)


@app.route("/api/login", methods=["POST"])
def login():
    d = request.get_json(silent=True) or {}
    username = (d.get("username") or "").strip()
    pw = d.get("password", "")
    keys = ["ip:" + client_ip(), "u:" + username.lower()]
    wait = login_locked(keys)
    if wait:
        return bad(f"嘗試次數過多，請 {wait // 60 + 1} 分鐘後再試", 429)
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    user = con.execute("SELECT * FROM users WHERE username=?", (username,)).fetchone()
    con.close()
    if user:
        pw_ok = check_password_hash(user["password_hash"], pw)
    else:
        check_password_hash(DUMMY_HASH, pw)   # equalize timing; no username oracle
        pw_ok = False
    if pw_ok:
        for k in keys:
            LOGIN_FAILS.pop(k, None)
        session.permanent = True
        session["uid"] = user["id"]
        session["tv"] = user["token_ver"]
        return jsonify(ok=True, username=user["username"], is_admin=bool(user["is_admin"]))
    login_failed(keys)
    time.sleep(0.6)
    return bad("帳號或密碼錯誤", 401)


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return jsonify(ok=True)


@app.route("/api/me/password", methods=["POST"])
@auth_required
def change_own_password():
    d = request.get_json(silent=True) or {}
    old, new = d.get("old", ""), d.get("new", "")
    if len(new) < 8:
        return bad("新密碼至少 8 碼")
    if not check_password_hash(g.user["password_hash"], old):
        time.sleep(0.6)
        return bad("目前密碼錯誤")
    con = db()
    new_ver = g.user["token_ver"] + 1
    con.execute("UPDATE users SET password_hash=?, token_ver=? WHERE id=?",
                (generate_password_hash(new), new_ver, g.user["id"]))
    con.commit()
    session["tv"] = new_ver
    return jsonify(ok=True)


# ---------- user management (admin) ----------

@app.route("/api/users")
@admin_required
def list_users():
    con = db()
    out = []
    for u in con.execute("SELECT id, username, is_admin FROM users ORDER BY id"):
        counts = {t: con.execute(
            f"SELECT COUNT(*) FROM {t} WHERE user_id=?", (u["id"],)).fetchone()[0]
            for t in DATA_TABLES}
        out.append({"id": u["id"], "username": u["username"],
                    "is_admin": bool(u["is_admin"]), "counts": counts})
    return jsonify(users=out)


@app.route("/api/users", methods=["POST"])
@admin_required
def create_user():
    d = request.get_json(silent=True) or {}
    username = (d.get("username") or "").strip()
    password = d.get("password", "")
    is_admin = 1 if d.get("is_admin") else 0
    if not USERNAME_RE.match(username):
        return bad("帳號限 2–20 位英數字（可含 _ . -）")
    if len(password) < 8:
        return bad("密碼至少 8 碼")
    con = db()
    if con.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
        return bad("帳號已存在")
    con.execute("INSERT INTO users(username,password_hash,is_admin) VALUES(?,?,?)",
                (username, generate_password_hash(password), is_admin))
    con.commit()
    return jsonify(ok=True)


@app.route("/api/users/<int:target>", methods=["PATCH"])
@admin_required
def edit_user(target):
    d = request.get_json(silent=True) or {}
    con = db()
    u = con.execute("SELECT * FROM users WHERE id=?", (target,)).fetchone()
    if not u:
        return bad("找不到使用者", 404)
    if "password" in d:
        if len(d["password"]) < 8:
            return bad("密碼至少 8 碼")
        con.execute("UPDATE users SET password_hash=?, token_ver=token_ver+1 WHERE id=?",
                    (generate_password_hash(d["password"]), target))
    if "is_admin" in d:
        new_admin = 1 if d["is_admin"] else 0
        if u["is_admin"] and not new_admin:
            admins = con.execute("SELECT COUNT(*) FROM users WHERE is_admin=1").fetchone()[0]
            if admins <= 1:
                return bad("至少需保留一位管理員")
        con.execute("UPDATE users SET is_admin=? WHERE id=?", (new_admin, target))
    con.commit()
    return jsonify(ok=True)


@app.route("/api/users/<int:target>", methods=["DELETE"])
@admin_required
def delete_user(target):
    con = db()
    u = con.execute("SELECT * FROM users WHERE id=?", (target,)).fetchone()
    if not u:
        return bad("找不到使用者", 404)
    if target == g.user["id"]:
        return bad("無法刪除自己")
    keep = write_user_snapshot(con, target, "pre-delete")
    for fn in os.listdir(BACKUP_DIR):
        m = USER_BK_RE.match(fn)
        if m and m.group(1) == str(target) and fn != keep:
            os.unlink(os.path.join(BACKUP_DIR, fn))
    for t in DATA_TABLES:
        con.execute(f"DELETE FROM {t} WHERE user_id=?", (target,))
    con.execute("DELETE FROM users WHERE id=?", (target,))
    con.commit()
    return jsonify(ok=True)


# ---------- data ----------

MONTHLY_SQL = """
SELECT substr(date,1,7) AS ym,
       SUM(price - card_fee) AS revenue,
       SUM(cost) AS cost,
       SUM(commission) AS commission,
       SUM(extra_fee) AS extra,
       SUM(price - card_fee) - SUM(cost) - SUM(commission) - SUM(extra_fee) AS profit,
       COUNT(*) AS qty
FROM sales WHERE user_id=? GROUP BY ym ORDER BY ym
"""

# cash-basis view of 居間特許 money flow: deposit receipt counts in the deposit month
# (whether the machine has sold yet — consignments — or not — the sale row),
# deposit refund + net commission payout count in the settlement month
FRANCHISE_FLOW_SQL = """
SELECT ym, SUM(dep_in) AS dep_in, SUM(dep_out) AS dep_out,
       SUM(comm_net) AS comm_net, SUM(tax) AS tax, SUM(health) AS health
FROM (
  SELECT substr(deposit_date,1,7) AS ym, deposit AS dep_in, 0 AS dep_out, 0 AS comm_net, 0 AS tax, 0 AS health
    FROM sales WHERE user_id=? AND sale_type='franchise' AND deposit_date<>'' AND deposit>0
  UNION ALL
  SELECT substr(settle_date,1,7), 0, deposit, commission - tax - health_fee, tax, health_fee
    FROM sales WHERE user_id=? AND sale_type='franchise' AND settled=1 AND settle_date<>''
  UNION ALL
  SELECT substr(deposit_date,1,7), deposit, 0, 0, 0, 0
    FROM consignments WHERE user_id=? AND deposit_date<>'' AND deposit>0
  UNION ALL
  SELECT substr(refund_date,1,7), 0, refund_amount, 0, 0, 0
    FROM consignments WHERE user_id=? AND returned=1 AND refund_date<>'' AND refund_amount>0
) GROUP BY ym ORDER BY ym
"""


@app.route("/api/data")
@auth_required
def data():
    con = db()
    uid = g.user["id"]
    return jsonify(
        me={"username": g.user["username"], "is_admin": bool(g.user["is_admin"])},
        units=[dict(r) for r in con.execute(
            "SELECT * FROM units WHERE user_id=? ORDER BY model, serial", (uid,))],
        purchases=[dict(r) for r in con.execute(
            "SELECT * FROM purchases WHERE user_id=? ORDER BY date DESC, id DESC", (uid,))],
        sales=[dict(r) for r in con.execute(
            "SELECT * FROM sales WHERE user_id=? ORDER BY date DESC, id DESC", (uid,))],
        trials=[dict(r) for r in con.execute(
            "SELECT * FROM trials WHERE user_id=? ORDER BY returned, start_date DESC, id DESC", (uid,))],
        monthly=[dict(r) for r in con.execute(MONTHLY_SQL, (uid,))],
        franchise_flow=[dict(r) for r in con.execute(FRANCHISE_FLOW_SQL, (uid, uid, uid, uid))],
        consignments=[dict(r) for r in con.execute(
            "SELECT c.*, u.serial AS serial, u.model AS model FROM consignments c"
            " LEFT JOIN units u ON u.id=c.unit_id WHERE c.user_id=?"
            " ORDER BY c.deposit_date DESC, c.id DESC", (uid,))],
        agent_owing=[dict(r) for r in con.execute(
            "SELECT agent, COUNT(*) AS n,"
            " SUM(deposit) AS deposit, SUM(commission - tax - health_fee) AS net_comm,"
            " SUM(deposit + commission - tax - health_fee) AS payable"
            " FROM sales WHERE user_id=? AND sale_type='franchise' AND settled=0 AND (deposit>0 OR commission>0) AND agent<>''"
            " GROUP BY agent ORDER BY agent", (uid,))],
        customers=[r[0] for r in con.execute(
            "SELECT DISTINCT customer FROM sales WHERE user_id=? AND customer<>'' ORDER BY customer", (uid,))],
        agents=[r[0] for r in con.execute(
            "SELECT DISTINCT agent FROM sales WHERE user_id=? AND agent<>'' ORDER BY agent", (uid,))],
    )


# ---------- purchases ----------

@app.route("/api/purchase", methods=["POST"])
@auth_required
def add_purchase():
    d = request.get_json(silent=True) or {}
    uid = g.user["id"]
    date, model = (d.get("date") or "").strip(), (d.get("model") or "").strip()
    total = as_int(d.get("total"), -1)
    serials = [s.strip() for s in d.get("serials", []) if s and s.strip()]
    status = d.get("status", "in_stock")
    if not date or not model or total < 0 or not serials:
        return bad("日期、型號、金額、貨號皆為必填")
    if not valid_date(date):
        return bad("日期格式須為 YYYY-MM-DD")
    if len(serials) > 50:
        return bad("一次最多 50 台")
    if status not in ("in_stock", "trial"):
        return bad("入庫類型不正確")
    if len(set(serials)) != len(serials):
        return bad("貨號重複")
    con = db()
    exists = [s for s in serials if con.execute(
        "SELECT 1 FROM units WHERE serial=? AND user_id=?", (s, uid)).fetchone()]
    if exists:
        return bad("貨號已存在：" + "、".join(exists))
    n = len(serials)
    base_cost = total // n
    cur = con.execute(
        "INSERT INTO purchases(date,model,qty,total,note,user_id) VALUES(?,?,?,?,?,?)",
        (date, model, n, total, d.get("note", ""), uid),
    )
    pid = cur.lastrowid
    for i, s in enumerate(serials):
        cost = total - base_cost * (n - 1) if i == 0 else base_cost
        con.execute(
            "INSERT INTO units(serial,model,purchase_id,cost,status,user_id) VALUES(?,?,?,?,?,?)",
            (s, model, pid, cost, status, uid),
        )
    con.commit()
    return jsonify(ok=True, id=pid)


@app.route("/api/purchase/<int:pid>", methods=["PATCH"])
@auth_required
def edit_purchase(pid):
    d = request.get_json(silent=True) or {}
    uid = g.user["id"]
    con = db()
    p = con.execute("SELECT * FROM purchases WHERE id=? AND user_id=?", (pid, uid)).fetchone()
    if not p:
        return bad("找不到此筆進貨", 404)
    date = (d.get("date") or p["date"]).strip()
    model = (d.get("model") or p["model"]).strip()
    total = as_int(d.get("total", p["total"]), p["total"])
    note = d.get("note", p["note"])
    if not date or not model or total < 0:
        return bad("日期、型號、金額皆為必填")
    if not valid_date(date):
        return bad("日期格式須為 YYYY-MM-DD")
    con.execute("UPDATE purchases SET date=?, model=?, total=?, note=? WHERE id=?",
                (date, model, total, note, pid))
    if total != p["total"]:
        unit_ids = [r["id"] for r in con.execute(
            "SELECT id FROM units WHERE purchase_id=? AND user_id=? ORDER BY id", (pid, uid))]
        n = len(unit_ids)
        if n:
            base = total // n
            for i, u in enumerate(unit_ids):
                cost = total - base * (n - 1) if i == 0 else base
                con.execute("UPDATE units SET cost=? WHERE id=?", (cost, u))
    con.commit()
    return jsonify(ok=True)


@app.route("/api/purchase/<int:pid>", methods=["DELETE"])
@auth_required
def del_purchase(pid):
    uid = g.user["id"]
    con = db()
    if not con.execute("SELECT 1 FROM purchases WHERE id=? AND user_id=?", (pid, uid)).fetchone():
        return bad("找不到此筆進貨", 404)
    sold = con.execute(
        "SELECT COUNT(*) FROM units WHERE purchase_id=? AND user_id=? AND status IN ('sold','consigned','trial')",
        (pid, uid)).fetchone()[0]
    if sold:
        return bad("此筆進貨已有機器售出／試用／特許持機，無法刪除")
    con.execute("DELETE FROM units WHERE purchase_id=? AND user_id=?", (pid, uid))
    con.execute("DELETE FROM purchases WHERE id=? AND user_id=?", (pid, uid))
    con.commit()
    return jsonify(ok=True)


# ---------- sales ----------

@app.route("/api/sale", methods=["POST"])
@auth_required
def add_sale():
    d = request.get_json(silent=True) or {}
    uid = g.user["id"]
    date = (d.get("date") or "").strip()
    customer = (d.get("customer") or "").strip()
    unit_ids = d.get("unit_ids") or []
    unit_ids = list(dict.fromkeys(unit_ids))
    total_price = as_int(d.get("total_price"), -1)
    card_fee = as_int(d.get("card_fee"), 0)
    warranty = (d.get("warranty_no") or "").strip()
    fixes = d.get("serial_fix") or {}
    note = d.get("note", "")
    sale_type = d.get("sale_type") or "normal"
    if not date or not customer or not unit_ids or total_price < 0:
        return bad("日期、客戶、貨號、金額皆為必填")
    if not valid_date(date):
        return bad("日期格式須為 YYYY-MM-DD")
    if sale_type not in ("normal", "franchise"):
        return bad("類別不正確")
    extra_fee = as_int(d.get("extra_fee"), 0)
    extra_label = (d.get("extra_label") or "").strip()
    if extra_fee < 0:
        return bad("其他費用格式不正確")
    agent = ""
    deposit = commission = tax = health_fee = 0
    deposit_date = settle_date = ""
    if sale_type == "franchise":
        agent = (d.get("agent") or "").strip()
        if not agent:
            return bad("特許人必填")
        deposit = as_int(d.get("deposit"), -1)
        if deposit < 0:
            return bad("保證金格式不正確")
        if deposit > total_price:
            return bad("保證金不可大於售價")
        deposit_date = (d.get("deposit_date") or "").strip()
        if not deposit_date or not valid_date(deposit_date):
            return bad("保證金收款日格式須為 YYYY-MM-DD")
        commission = total_price - deposit
        # 保證金% + 佣金% = 100%; withholdings come out of the commission, so it may not drop below 12.11%
        if total_price > 0 and commission * 10000 < total_price * 1211:
            return bad("佣金比例不可低於 12.11%")
        # tax/health default to the statutory rates but the form may hand-override them
        tax = as_int(d.get("tax"), -1)
        if tax < 0:
            tax = half_up(commission * WITHHOLD_RATE)
        health_fee = as_int(d.get("health_fee"), -1)
        if health_fee < 0:
            health_fee = half_up(commission * HEALTH_RATE)
        # expected payout date (inert until settled=1): next month's 15th unless the form supplies one
        settle_date = (d.get("settle_date") or "").strip()
        if settle_date:
            if not valid_date(settle_date):
                return bad("結清日期格式須為 YYYY-MM-DD")
        else:
            settle_date = next_month_15(date)
    con = db()
    units = [con.execute("SELECT * FROM units WHERE id=? AND user_id=?", (i, uid)).fetchone()
             for i in unit_ids]
    if any(u is None for u in units):
        return bad("找不到指定的機器")
    # franchise sales may sell units a 特許 already holds (consigned); normal sales may not
    ok_status = ("in_stock", "consigned") if sale_type == "franchise" else ("in_stock",)
    not_avail = [u["serial"] for u in units if u["status"] not in ok_status]
    if not_avail:
        consigned = [u["serial"] for u in units if u["status"] == "consigned"]
        if consigned and sale_type != "franchise":
            return bad("特許持機中：" + "、".join(consigned) + "（請用居間特許類別售出）")
        return bad("非在庫（已售／試用機／除役）：" + "、".join(not_avail))
    n = len(units)
    base = total_price // n
    for i, u in enumerate(units):
        price = total_price - base * (n - 1) if i == 0 else base
        serial = (fixes.get(str(u["id"])) or "").strip() or u["serial"]
        if serial != u["serial"]:
            if con.execute("SELECT 1 FROM units WHERE serial=? AND user_id=? AND id<>?",
                           (serial, uid, u["id"])).fetchone():
                return bad("貨號已存在：" + serial)
            con.execute("UPDATE units SET serial=? WHERE id=?", (serial, u["id"]))
        con.execute(
            "INSERT INTO sales(date,customer,unit_id,model,serial,price,card_fee,cost,warranty_no,note,user_id,"
            "sale_type,agent,deposit,deposit_date,commission,tax,health_fee,settled,settle_date,extra_fee,extra_label)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (date, customer, u["id"], u["model"], serial, price,
             card_fee if i == 0 else 0, u["cost"], warranty, note, uid,
             sale_type, agent,
             deposit if i == 0 else 0, deposit_date if i == 0 else "",
             commission if i == 0 else 0, tax if i == 0 else 0, health_fee if i == 0 else 0,
             0, settle_date if i == 0 else "",
             extra_fee if i == 0 else 0, extra_label if i == 0 else ""),
        )
        con.execute("UPDATE units SET status='sold' WHERE id=?", (u["id"],))
        # a sold consigned unit consumes its ACTIVE 特許領機 record — its deposit info
        # now lives on the sale row (keeps dep_in counted exactly once). Returned
        # consignments (returned=1) are historical and must be preserved.
        con.execute("DELETE FROM consignments WHERE unit_id=? AND user_id=? AND returned=0", (u["id"], uid))
    con.commit()
    return jsonify(ok=True)


@app.route("/api/sale/<int:sid>", methods=["PATCH"])
@auth_required
def edit_sale(sid):
    d = request.get_json(silent=True) or {}
    uid = g.user["id"]
    con = db()
    s = con.execute("SELECT * FROM sales WHERE id=? AND user_id=?", (sid, uid)).fetchone()
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
    sale_type = d.get("sale_type") or s["sale_type"]
    if sale_type not in ("normal", "franchise"):
        return bad("類別不正確")
    agent = (d["agent"] if "agent" in d else s["agent"]).strip()
    deposit = as_int(d.get("deposit", s["deposit"]), s["deposit"])
    commission = as_int(d.get("commission", s["commission"]), s["commission"])
    tax = as_int(d.get("tax", s["tax"]), s["tax"])
    health_fee = as_int(d.get("health_fee", s["health_fee"]), s["health_fee"])
    deposit_date = (d["deposit_date"] if "deposit_date" in d else s["deposit_date"]).strip()
    settle_date = (d["settle_date"] if "settle_date" in d else s["settle_date"]).strip()
    settled = 1 if d.get("settled", s["settled"]) else 0
    extra_fee = as_int(d.get("extra_fee", s["extra_fee"]), s["extra_fee"])
    extra_label = (d["extra_label"] if "extra_label" in d else s["extra_label"]).strip()
    if extra_fee < 0:
        return bad("其他費用格式不正確")
    if not date or not customer or price < 0 or card_fee < 0 or cost < 0:
        return bad("日期、客戶、金額皆為必填")
    if not valid_date(date):
        return bad("日期格式須為 YYYY-MM-DD")
    if deposit < 0 or commission < 0 or tax < 0 or health_fee < 0:
        return bad("金額格式不正確")
    if (deposit_date and not valid_date(deposit_date)) or (settle_date and not valid_date(settle_date)):
        return bad("日期格式須為 YYYY-MM-DD")
    if settled and not settle_date:
        settle_date = datetime.date.today().isoformat()
    # a settled franchise row is a closed cycle: freeze every material field (category,
    # P&L amounts, franchise money, dates) until the owner explicitly un-settles first
    # (pass settled=0). This blocks the sale_type->normal force-zero bypass too.
    if s["settled"] == 1 and s["sale_type"] == "franchise" and settled:
        if (sale_type != s["sale_type"] or
            price != s["price"] or cost != s["cost"] or card_fee != s["card_fee"] or
            extra_fee != s["extra_fee"] or
            deposit != s["deposit"] or commission != s["commission"] or
            tax != s["tax"] or health_fee != s["health_fee"] or
            deposit_date != s["deposit_date"] or settle_date != s["settle_date"]):
            return bad("已結清，請先將此筆改為未結清再修改金額、成本或類別")
    if sale_type == "franchise":
        if not agent:
            return bad("特許人必填")
        if price > 0 and deposit > price:
            return bad("保證金不可大於售價")
        if price > 0 and commission * 10000 < price * 1211:
            return bad("佣金比例不可低於 12.11%")
        if tax + health_fee > commission:
            return bad("預扣稅款與補充保費合計不可大於佣金")
    else:
        # normal rows must carry no franchise money — MONTHLY_SQL sums commission unconditionally
        agent, deposit_date, settle_date = "", "", ""
        deposit = commission = tax = health_fee = settled = 0
    if s["unit_id"]:
        if not serial:
            return bad("此筆已連結機器，貨號不可空白")
        if serial != s["serial"]:
            if con.execute("SELECT 1 FROM units WHERE serial=? AND user_id=? AND id<>?",
                           (serial, uid, s["unit_id"])).fetchone():
                return bad("貨號已存在")
            con.execute("UPDATE units SET serial=? WHERE id=?", (serial, s["unit_id"]))
    con.execute(
        "UPDATE sales SET date=?, customer=?, model=?, serial=?, price=?, card_fee=?,"
        " cost=?, warranty_no=?, note=?, sale_type=?, agent=?, deposit=?, deposit_date=?, commission=?,"
        " tax=?, health_fee=?, settled=?, settle_date=?, extra_fee=?, extra_label=? WHERE id=?",
        (date, customer, model, serial, price, card_fee, cost, warranty, note,
         sale_type, agent, deposit, deposit_date, commission, tax, health_fee, settled, settle_date,
         extra_fee, extra_label, sid),
    )
    con.commit()
    return jsonify(ok=True)


@app.route("/api/sale/<int:sid>", methods=["DELETE"])
@auth_required
def del_sale(sid):
    uid = g.user["id"]
    con = db()
    row = con.execute("SELECT * FROM sales WHERE id=? AND user_id=?", (sid, uid)).fetchone()
    if not row:
        return bad("找不到此筆銷售", 404)
    # a settled franchise sale is a closed cycle (deposit refunded + commission paid);
    # deleting it would drop the payout record AND wrongly re-create a live consignment.
    if row["sale_type"] == "franchise" and row["settled"] == 1:
        return bad("已結清的居間特許無法刪除，請先於編輯中改為未結清")
    if row["unit_id"]:
        if row["sale_type"] == "franchise" and row["deposit"] > 0:
            con.execute(
                "INSERT INTO consignments(agent,unit_id,deposit,deposit_date,note,user_id)"
                " VALUES(?,?,?,?,?,?)",
                (row["agent"], row["unit_id"], row["deposit"], row["deposit_date"], row["note"], uid)
            )
            con.execute("UPDATE units SET status='consigned' WHERE id=? AND user_id=?", (row["unit_id"], uid))
        else:
            con.execute("UPDATE units SET status='in_stock' WHERE id=? AND status='sold'",
                        (row["unit_id"],))
    con.execute("DELETE FROM sales WHERE id=?", (sid,))
    con.commit()
    return jsonify(ok=True)


@app.route("/api/settle-agent", methods=["POST"])
@auth_required
def settle_agent():
    d = request.get_json(silent=True) or {}
    uid = g.user["id"]
    agent = (d.get("agent") or "").strip()
    if not agent:
        return bad("特許人必填")
    settle_date = (d.get("settle_date") or "").strip()
    if settle_date:
        if not valid_date(settle_date):
            return bad("結清日期格式須為 YYYY-MM-DD")
    else:
        settle_date = datetime.date.today().isoformat()
    con = db()
    cur = con.execute(
        "UPDATE sales SET settled=1, settle_date=? "
        "WHERE user_id=? AND sale_type='franchise' AND agent=? AND settled=0 AND (deposit>0 OR commission>0)",
        (settle_date, uid, agent),
    )
    con.commit()
    return jsonify(ok=True, count=cur.rowcount)


# ---------- trials ----------

@app.route("/api/trial", methods=["POST"])
@auth_required
def add_trial():
    d = request.get_json(silent=True) or {}
    customer = (d.get("customer") or "").strip()
    if not customer:
        return bad("請填寫人名")
    for dv in (d.get("start_date", ""), d.get("end_date", "")):
        if dv and not valid_date(dv):
            return bad("日期格式須為 YYYY-MM-DD")
    rent_type = (d.get("rent_type") or "").strip()
    if rent_type and rent_type not in RENT_TYPES:
        return bad("租類不正確")
    con = db()
    con.execute(
        "INSERT INTO trials(customer,model,start_date,end_date,note,user_id,rent_type) VALUES(?,?,?,?,?,?,?)",
        (customer, d.get("model", ""), d.get("start_date", ""), d.get("end_date", ""),
         d.get("note", ""), g.user["id"], rent_type),
    )
    con.commit()
    return jsonify(ok=True)


@app.route("/api/trial/<int:tid>/return", methods=["POST"])
@auth_required
def return_trial(tid):
    con = db()
    con.execute("UPDATE trials SET returned=1 WHERE id=? AND user_id=?", (tid, g.user["id"]))
    con.commit()
    return jsonify(ok=True)


@app.route("/api/trial/<int:tid>", methods=["PATCH"])
@auth_required
def edit_trial(tid):
    d = request.get_json(silent=True) or {}
    con = db()
    t = con.execute("SELECT * FROM trials WHERE id=? AND user_id=?", (tid, g.user["id"])).fetchone()
    if not t:
        return bad("找不到此筆試用", 404)
    customer = (d["customer"] if "customer" in d else t["customer"]).strip()
    model = (d["model"] if "model" in d else t["model"]).strip()
    start = (d["start_date"] if "start_date" in d else t["start_date"]).strip()
    end = (d["end_date"] if "end_date" in d else t["end_date"]).strip()
    if (start and not valid_date(start)) or (end and not valid_date(end)):
        return bad("日期格式須為 YYYY-MM-DD")
    note = d.get("note", t["note"])
    returned = 1 if d.get("returned", t["returned"]) else 0
    rent_type = (d["rent_type"] if "rent_type" in d else t["rent_type"]).strip()
    if rent_type and rent_type not in RENT_TYPES:
        return bad("租類不正確")
    con.execute(
        "UPDATE trials SET customer=?, model=?, start_date=?, end_date=?, note=?, returned=?, rent_type=? WHERE id=?",
        (customer, model, start, end, note, returned, rent_type, tid),
    )
    con.commit()
    return jsonify(ok=True)


@app.route("/api/trial/<int:tid>", methods=["DELETE"])
@auth_required
def del_trial(tid):
    con = db()
    con.execute("DELETE FROM trials WHERE id=? AND user_id=?", (tid, g.user["id"]))
    con.commit()
    return jsonify(ok=True)


# ---------- consignments (特許領機) ----------

@app.route("/api/consign", methods=["POST"])
@auth_required
def add_consign():
    d = request.get_json(silent=True) or {}
    uid = g.user["id"]
    agent = (d.get("agent") or "").strip()
    if not agent:
        return bad("特許人必填")
    deposit = as_int(d.get("deposit"), -1)
    if deposit < 0:
        return bad("保證金格式不正確")
    deposit_date = (d.get("deposit_date") or "").strip()
    if not deposit_date or not valid_date(deposit_date):
        return bad("保證金收款日格式須為 YYYY-MM-DD")
    con = db()
    u = con.execute("SELECT * FROM units WHERE id=? AND user_id=?",
                    (d.get("unit_id"), uid)).fetchone()
    if not u:
        return bad("找不到指定的機器")
    if u["status"] != "in_stock":
        return bad("非在庫（已售／試用機／除役／特許持機）：" + u["serial"])
    cur = con.execute(
        "INSERT INTO consignments(agent,unit_id,deposit,deposit_date,note,user_id)"
        " VALUES(?,?,?,?,?,?)",
        (agent, u["id"], deposit, deposit_date, d.get("note", ""), uid))
    con.execute("UPDATE units SET status='consigned' WHERE id=?", (u["id"],))
    con.commit()
    return jsonify(ok=True, id=cur.lastrowid)


@app.route("/api/consign/<int:cid>", methods=["PATCH"])
@auth_required
def edit_consign(cid):
    d = request.get_json(silent=True) or {}
    uid = g.user["id"]
    con = db()
    cg = con.execute("SELECT * FROM consignments WHERE id=? AND user_id=?", (cid, uid)).fetchone()
    if not cg:
        return bad("找不到此筆特許領機", 404)
    agent = (d["agent"] if "agent" in d else cg["agent"]).strip()
    if not agent:
        return bad("特許人必填")
    deposit = as_int(d.get("deposit", cg["deposit"]), cg["deposit"])
    if deposit < 0:
        return bad("保證金格式不正確")
    deposit_date = (d["deposit_date"] if "deposit_date" in d else cg["deposit_date"]).strip()
    if not deposit_date or not valid_date(deposit_date):
        return bad("保證金收款日格式須為 YYYY-MM-DD")
    note = d.get("note", cg["note"])
    con.execute("UPDATE consignments SET agent=?, deposit=?, deposit_date=?, note=? WHERE id=?",
                (agent, deposit, deposit_date, note, cid))
    con.commit()
    return jsonify(ok=True)


@app.route("/api/consign/<int:cid>/return", methods=["POST"])
@auth_required
def return_consign(cid):
    uid = g.user["id"]
    con = db()
    cg = con.execute("SELECT * FROM consignments WHERE id=? AND user_id=?", (cid, uid)).fetchone()
    if not cg:
        return bad("找不到此筆特許領機", 404)
    if cg["returned"]:
        return bad("此筆已退回")
    d = request.get_json(silent=True) or {}
    refund_date = (d.get("refund_date") or "").strip()
    if not refund_date:
        refund_date = datetime.date.today().isoformat()
    if not valid_date(refund_date):
        return bad("退回日期格式須為 YYYY-MM-DD")
    ref_amt_val = d.get("refund_amount")
    if ref_amt_val is None:
        refund_amount = cg["deposit"]
    else:
        refund_amount = as_int(ref_amt_val, -1)
        if refund_amount < 0:
            return bad("退款金額格式不正確")
    con.execute("UPDATE consignments SET returned=1, refund_date=?, refund_amount=? WHERE id=?",
                (refund_date, refund_amount, cid))
    if cg["unit_id"]:
        con.execute("UPDATE units SET status='in_stock' WHERE id=? AND status='consigned'",
                    (cg["unit_id"],))
    con.commit()
    return jsonify(ok=True)


@app.route("/api/consign/<int:cid>", methods=["DELETE"])
@auth_required
def del_consign(cid):
    uid = g.user["id"]
    con = db()
    cg = con.execute("SELECT * FROM consignments WHERE id=? AND user_id=?", (cid, uid)).fetchone()
    if not cg:
        return bad("找不到此筆特許領機", 404)
    if cg["unit_id"]:
        con.execute("UPDATE units SET status='in_stock' WHERE id=? AND status='consigned'",
                    (cg["unit_id"],))
    con.execute("DELETE FROM consignments WHERE id=?", (cid,))
    con.commit()
    return jsonify(ok=True)


# ---------- units ----------

@app.route("/api/unit/<int:uid_>", methods=["PATCH"])
@auth_required
def edit_unit(uid_):
    d = request.get_json(silent=True) or {}
    owner = g.user["id"]
    con = db()
    u = con.execute("SELECT * FROM units WHERE id=? AND user_id=?", (uid_, owner)).fetchone()
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
    if u["status"] == "consigned" and status != "consigned":
        return bad("特許持機中，請先於銷售頁售出或取消該筆特許領機")
    if u["status"] != "consigned" and status == "consigned":
        return bad("請用「特許領機」登記")
    dup = con.execute("SELECT 1 FROM units WHERE serial=? AND user_id=? AND id<>?",
                      (serial, owner, uid_)).fetchone()
    if dup:
        return bad("貨號已存在")
    con.execute("UPDATE units SET serial=?, note=?, cost=?, status=? WHERE id=?",
                (serial, note, cost, status, uid_))
    con.execute("UPDATE sales SET serial=? WHERE unit_id=?", (serial, uid_))
    con.commit()
    return jsonify(ok=True)


# ---------- export ----------

def xl(v):
    return ("'" + v) if isinstance(v, str) and v[:1] in ("=", "+", "-", "@") else v


def build_workbook(con, uid):
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
    ws.append(["月份", "銷售總額", "銷貨成本", "佣金", "其他費用", "毛利", "銷售數量", "毛利率"])
    rows = list(con.execute(MONTHLY_SQL, (uid,)))
    for r in rows:
        ws.append([r["ym"], r["revenue"], r["cost"], r["commission"], r["extra"], r["profit"], r["qty"],
                   (r["profit"] / r["revenue"]) if r["revenue"] else 0])
    if rows:
        tr = sum(r["revenue"] for r in rows)
        tc = sum(r["cost"] for r in rows)
        tcm = sum(r["commission"] for r in rows)
        tx = sum(r["extra"] for r in rows)
        tq = sum(r["qty"] for r in rows)
        tp = tr - tc - tcm - tx
        ws.append(["合計", tr, tc, tcm, tx, tp, tq, (tp / tr) if tr else 0])
        ws.cell(row=len(rows) + 2, column=1).font = Font(bold=True)
    for row in ws.iter_rows(min_row=2, min_col=2, max_col=6):
        for cell in row:
            cell.number_format = money
    for row in ws.iter_rows(min_row=2, min_col=8, max_col=8):
        for cell in row:
            cell.number_format = "0.0%"
    style_head(ws, 8, [10, 12, 12, 11, 11, 12, 10, 9])

    ws = wb.create_sheet("特許金流")
    ws.append(["月份", "保證金收", "退保證金", "實付佣金", "預扣稅款", "補充保費", "淨流"])
    frows = list(con.execute(FRANCHISE_FLOW_SQL, (uid, uid, uid, uid)))
    for r in frows:
        net = r["dep_in"] - r["dep_out"] - r["comm_net"] - r["tax"] - r["health"]
        ws.append([r["ym"], r["dep_in"], r["dep_out"], r["comm_net"], r["tax"], r["health"], net])
    if frows:
        tdi = sum(r["dep_in"] for r in frows)
        tdo = sum(r["dep_out"] for r in frows)
        tcn = sum(r["comm_net"] for r in frows)
        ttx = sum(r["tax"] for r in frows)
        thl = sum(r["health"] for r in frows)
        ws.append(["合計", tdi, tdo, tcn, ttx, thl, tdi - tdo - tcn - ttx - thl])
        ws.cell(row=len(frows) + 2, column=1).font = Font(bold=True)
    for row in ws.iter_rows(min_row=2, min_col=2, max_col=7):
        for cell in row:
            cell.number_format = money
    style_head(ws, 7, [10, 12, 12, 12, 12, 12, 12])

    ws = wb.create_sheet("特許人扣繳彙總")
    ws.append(["年度", "特許人", "筆數", "佣金合計", "預扣稅款合計", "補充保費合計", "實付佣金合計"])
    q_tax = """
    SELECT substr(date,1,4) AS yr, agent,
           COUNT(*) AS n, SUM(commission) AS comm, SUM(tax) AS tax, SUM(health_fee) AS health,
           SUM(commission - tax - health_fee) AS net
    FROM sales WHERE user_id=? AND sale_type='franchise' AND agent<>''
    GROUP BY yr, agent ORDER BY yr, agent
    """
    for r in con.execute(q_tax, (uid,)):
        ws.append([r["yr"], xl(r["agent"]), r["n"], r["comm"], r["tax"], r["health"], r["net"]])
    for row in ws.iter_rows(min_row=2, min_col=4, max_col=7):
        for cell in row:
            cell.number_format = money
    style_head(ws, 7, [8, 12, 8, 12, 12, 12, 12])

    ws = wb.create_sheet("銷售明細")
    ws.append(["日期", "客戶", "類別", "特許人", "型號", "貨號", "保證書編號", "銷售單價", "刷卡費",
               "其他費用", "費用名稱", "實收", "進貨成本", "毛利", "保證金", "保證金收款日", "佣金",
               "預扣稅款", "補充保費", "實付佣金", "結清", "結清日期", "備註"])
    for s in con.execute("SELECT * FROM sales WHERE user_id=? ORDER BY date, id", (uid,)):
        net = s["price"] - s["card_fee"]
        is_fr = s["sale_type"] == "franchise"
        category = "居間特許" if is_fr else "一般"
        gp = net - s["cost"] - s["commission"] - s["extra_fee"]
        money_row = is_fr and (s["deposit"] > 0 or s["commission"] > 0)
        if money_row:
            franchise_cells = [s["deposit"], s["deposit_date"], s["commission"], s["tax"], s["health_fee"],
                                s["commission"] - s["tax"] - s["health_fee"],
                                "已結清" if s["settled"] else "未結清", s["settle_date"]]
        else:
            franchise_cells = ["", "", "", "", "", "", "", ""]
        ws.append([s["date"], xl(s["customer"]), category, xl(s["agent"]), xl(s["model"]), xl(s["serial"]),
                   xl(s["warranty_no"]), s["price"], s["card_fee"],
                   s["extra_fee"] or "", xl(s["extra_label"]), net, s["cost"], gp,
                   *franchise_cells, xl(s["note"])])
    for row in ws.iter_rows(min_row=2, min_col=8, max_col=10):
        for cell in row:
            cell.number_format = money
    for row in ws.iter_rows(min_row=2, min_col=12, max_col=15):
        for cell in row:
            cell.number_format = money
    for row in ws.iter_rows(min_row=2, min_col=17, max_col=20):
        for cell in row:
            cell.number_format = money
    style_head(ws, 23, [11, 10, 10, 10, 11, 12, 13, 11, 9, 10, 11, 11, 11, 11, 11, 14, 10, 11, 11, 11, 8, 12, 24])

    ws = wb.create_sheet("進貨明細")
    ws.append(["日期", "型號", "數量", "金額", "備註"])
    for p in con.execute("SELECT * FROM purchases WHERE user_id=? ORDER BY date, id", (uid,)):
        ws.append([p["date"], xl(p["model"]), p["qty"], p["total"], xl(p["note"])])
    for row in ws.iter_rows(min_row=2, min_col=4, max_col=4):
        for cell in row:
            cell.number_format = money
    style_head(ws, 5, [11, 24, 8, 12, 36])

    ws = wb.create_sheet("庫存")
    ws.append(["貨號", "型號", "狀態", "成本", "備註"])
    label = {"in_stock": "在庫", "sold": "已售", "trial": "試用機", "retired": "除役", "consigned": "特許機"}
    for u in con.execute("SELECT * FROM units WHERE user_id=? ORDER BY status, model, serial", (uid,)):
        ws.append([xl(u["serial"]), xl(u["model"]), label.get(u["status"], u["status"]), u["cost"], xl(u["note"])])
    for row in ws.iter_rows(min_row=2, min_col=4, max_col=4):
        for cell in row:
            cell.number_format = money
    style_head(ws, 5, [14, 12, 9, 11, 32])

    ws = wb.create_sheet("試用出租")
    ws.append(["人名", "型號", "租類", "開始", "結束", "狀態", "備註"])
    rent_label_map = {"week7": "七天租", "month": "月租", "franchise": "特許租用", "hq": "總部月租", "": ""}
    for t in con.execute("SELECT * FROM trials WHERE user_id=? ORDER BY returned, start_date", (uid,)):
        ws.append([xl(t["customer"]), xl(t["model"]), rent_label_map.get(t["rent_type"], ""), t["start_date"], t["end_date"],
                   "已歸還" if t["returned"] else "進行中", xl(t["note"])])
    style_head(ws, 7, [12, 11, 11, 11, 11, 9, 28])
    return wb


@app.route("/api/export.xlsx")
@auth_required
def export_xlsx():
    wb = build_workbook(db(), g.user["id"])
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
# Two layers:
#   1. per-user JSON snapshots — any user can back up / restore THEIR OWN rows
#   2. whole-DB file snapshots (cron + pre-restore) — admin only, affects everyone

SYS_BK_RE = re.compile(r"^denba-(\d{8}|pre-restore-\d{8}-\d{6})\.db$")
USER_BK_RE = re.compile(r"^user(\d+)-(pre-restore-|pre-delete-)?(\d{8}-\d{6})\.json$")


def snapshot_db(dest_path):
    src = sqlite3.connect(DB_PATH)
    dst = sqlite3.connect(dest_path)
    src.backup(dst)
    dst.close()
    src.close()


def dump_user(con, uid):
    out = {}
    for t in DATA_TABLES:
        out[t] = [dict(r) for r in con.execute(f"SELECT * FROM {t} WHERE user_id=?", (uid,))]
    return out


def write_user_snapshot(con, uid, tag=""):
    os.makedirs(BACKUP_DIR, exist_ok=True)
    ts = datetime.datetime.now().strftime("%Y%m%d-%H%M%S")
    prefix = f"user{uid}-{tag}-" if tag else f"user{uid}-"
    name = f"{prefix}{ts}.json"
    with open(os.path.join(BACKUP_DIR, name), "w", encoding="utf-8") as f:
        json.dump(dump_user(con, uid), f, ensure_ascii=False)
    keep = 15
    mine = sorted(f for f in os.listdir(BACKUP_DIR)
                  if USER_BK_RE.match(f) and USER_BK_RE.match(f).group(1) == str(uid))
    for old in mine[:-keep]:
        os.unlink(os.path.join(BACKUP_DIR, old))
    return name


def restore_user(con, uid, payload):
    for t in DATA_TABLES:
        con.execute(f"DELETE FROM {t} WHERE user_id=?", (uid,))
    pmap, umap = {}, {}
    for p in payload.get("purchases", []):
        cur = con.execute(
            "INSERT INTO purchases(date,model,qty,total,note,user_id) VALUES(?,?,?,?,?,?)",
            (p["date"], p["model"], p["qty"], p["total"], p.get("note", ""), uid))
        pmap[p["id"]] = cur.lastrowid
    for u in payload.get("units", []):
        cur = con.execute(
            "INSERT INTO units(serial,model,purchase_id,cost,status,note,user_id)"
            " VALUES(?,?,?,?,?,?,?)",
            (u["serial"], u["model"], pmap.get(u.get("purchase_id")), u["cost"],
             u["status"], u.get("note", ""), uid))
        umap[u["id"]] = cur.lastrowid
    for cg in payload.get("consignments", []):
        con.execute(
            "INSERT INTO consignments(agent,unit_id,deposit,deposit_date,note,user_id,"
            "returned,refund_date,refund_amount)"
            " VALUES(?,?,?,?,?,?,?,?,?)",
            (cg.get("agent", ""), umap.get(cg.get("unit_id")), cg.get("deposit", 0),
             cg.get("deposit_date", ""), cg.get("note", ""), uid,
             cg.get("returned", 0), cg.get("refund_date", ""), cg.get("refund_amount", 0)))
    for s in payload.get("sales", []):
        con.execute(
            "INSERT INTO sales(date,customer,unit_id,model,serial,price,card_fee,cost,warranty_no,note,user_id,"
            "sale_type,agent,deposit,deposit_date,commission,tax,health_fee,settled,settle_date,extra_fee,extra_label)"
            " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            (s["date"], s["customer"], umap.get(s.get("unit_id")), s["model"],
             s.get("serial", ""), s["price"], s.get("card_fee", 0), s["cost"],
             s.get("warranty_no", ""), s.get("note", ""), uid,
             s.get("sale_type", "normal"), s.get("agent", ""), s.get("deposit", 0),
             s.get("deposit_date", ""), s.get("commission", 0), s.get("tax", 0),
             s.get("health_fee", 0), s.get("settled", 0), s.get("settle_date", ""),
             s.get("extra_fee", 0), s.get("extra_label", "")))
    for t in payload.get("trials", []):
        con.execute(
            "INSERT INTO trials(customer,model,start_date,end_date,note,returned,user_id,rent_type)"
            " VALUES(?,?,?,?,?,?,?,?)",
            (t.get("customer", ""), t.get("model", ""), t.get("start_date", ""),
             t.get("end_date", ""), t.get("note", ""), t.get("returned", 0), uid,
             t.get("rent_type", "")))


@app.route("/api/backups")
@auth_required
def list_backups():
    os.makedirs(BACKUP_DIR, exist_ok=True)
    uid = str(g.user["id"])
    user_backups, system_backups = [], []
    for fn in os.listdir(BACKUP_DIR):
        full = os.path.join(BACKUP_DIR, fn)
        m = USER_BK_RE.match(fn)
        if m and m.group(1) == uid:
            st = os.stat(full)
            user_backups.append({"name": fn, "size": st.st_size, "mtime": int(st.st_mtime)})
        elif SYS_BK_RE.match(fn) and g.user["is_admin"]:
            st = os.stat(full)
            system_backups.append({"name": fn, "size": st.st_size, "mtime": int(st.st_mtime)})
    user_backups.sort(key=lambda x: x["mtime"], reverse=True)
    system_backups.sort(key=lambda x: (x["mtime"], x["name"]), reverse=True)
    return jsonify(user_backups=user_backups, system_backups=system_backups)


@app.route("/api/backup-now", methods=["POST"])
@auth_required
def backup_now():
    con = db()
    name = write_user_snapshot(con, g.user["id"])
    con.commit()
    return jsonify(ok=True, name=name)


@app.route("/api/restore", methods=["POST"])
@auth_required
def restore_backup():
    name = (request.get_json(silent=True) or {}).get("name", "")
    con = db()
    um = USER_BK_RE.match(name)
    if um:
        if um.group(1) != str(g.user["id"]):
            return bad("只能還原自己的備份", 403)
        path = os.path.join(BACKUP_DIR, name)
        if not os.path.exists(path):
            return bad("找不到備份檔", 404)
        with open(path, encoding="utf-8") as f:
            payload = json.load(f)
        pre = write_user_snapshot(con, g.user["id"], "pre-restore")
        restore_user(con, g.user["id"], payload)
        con.commit()
        return jsonify(ok=True, pre_restore=pre)
    if SYS_BK_RE.match(name):
        if not g.user["is_admin"]:
            return bad("需要管理員權限", 403)
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
    return bad("備份檔名不正確")


init_db()

if __name__ == "__main__":
    if len(sys.argv) >= 3 and sys.argv[1] == "export":
        cli_uid = int(sys.argv[3]) if len(sys.argv) >= 4 else 1
        cli_con = sqlite3.connect(DB_PATH)
        cli_con.row_factory = sqlite3.Row
        build_workbook(cli_con, cli_uid).save(sys.argv[2])
        cli_con.close()
    else:
        if not APP_PASSWORD:
            raise SystemExit("APP_PASSWORD 未設定（請在 denba.env 設定）")
        from waitress import serve
        serve(app, host="0.0.0.0", port=PORT, threads=4)
