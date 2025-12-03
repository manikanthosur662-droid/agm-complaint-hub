import os, json, time, sqlite3, base64
from functools import wraps
from datetime import datetime, timezone, timedelta
from typing import List
from flask import Flask, request, jsonify, g, Response, send_file
import openai, boto3, jwt, numpy as np
from dotenv import load_dotenv

load_dotenv()

# ---------------- ENV ----------------
OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
if not OPENAI_API_KEY:
    raise RuntimeError("Set OPENAI_API_KEY before running.")

openai.api_key = OPENAI_API_KEY

DB_PATH = os.getenv("AGM_DB", "complaints.db")
JWT_SECRET = os.getenv("JWT_SECRET", "very_secret_key")
JWT_EXP_MIN = int(os.getenv("JWT_EXP_MIN", "480"))
AWS_BUCKET = os.getenv("AWS_S3_BUCKET")
AWS_REGION = os.getenv("AWS_REGION", "us-east-1")

# ---------------- DEMO USERS ----------------
DEMO_USERS = {
    "mentor":   {"password": "pass123", "role": "admin"},
    "teacher":  {"password": "teach123", "role": "teacher"},
    "student":  {"password": "student123", "role": "student"}
}

# ---------------- FLASK APP ----------------
app = Flask(__name__)

# ---------------- DB INIT ----------------
def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(DB_PATH, check_same_thread=False)
        g.db.row_factory = sqlite3.Row
    return g.db

@app.teardown_appcontext
def close_db(exception):
    db = g.pop("db", None)
    if db:
        db.close()

def init_db():
    db = get_db()
    c = db.cursor()
    c.execute(\"\"\"
    CREATE TABLE IF NOT EXISTS complaints (
      id TEXT PRIMARY KEY,
      created_at TEXT,
      name TEXT,
      roll TEXT,
      category TEXT,
      priority TEXT,
      title TEXT,
      description TEXT,
      status TEXT,
      tags TEXT,
      attachment_name TEXT,
      attachment_url TEXT
    );
    \"\"\")
    c.execute(\"\"\"
    CREATE TABLE IF NOT EXISTS embeddings (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      text TEXT,
      vector BLOB
    );
    \"\"\")
    c.execute(\"\"\"
    CREATE TABLE IF NOT EXISTS resolved_history(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT
    );
    \"\"\")
    db.commit()

# ---------------- JWT ----------------
def make_jwt(username, role):
    payload = {
        "sub": username,
        "role": role,
        "exp": datetime.utcnow() + timedelta(minutes=JWT_EXP_MIN)
    }
    return jwt.encode(payload, JWT_SECRET, algorithm="HS256")

def decode_jwt(token):
    try:
        return jwt.decode(token, JWT_SECRET, algorithms=["HS256"])
    except:
        return None

def require_role(roles):
    def wrap(fn):
        @wraps(fn)
        def inner(*a,**k):
            auth = request.headers.get("Authorization","")
            if not auth.startswith("Bearer "):
                return jsonify({"error":"unauthorized"}), 401
            tok = auth.split(" ",1)[1]
            data = decode_jwt(tok)
            if not data: return jsonify({"error":"invalid token"}),401
            if data["role"] not in roles:
                return jsonify({"error":"forbidden"}),403
            request.user = data
            return fn(*a,**k)
        return inner
    return wrap

# ---------------- S3 PRESIGN ----------------
def get_s3():
    if not AWS_BUCKET:
        return None
    return boto3.client("s3", region_name=AWS_REGION)

def create_presigned_put(key, ctype):
    s3 = get_s3()
    if not s3: return None
    return s3.generate_presigned_url(
        "put_object",
        Params={"Bucket":AWS_BUCKET,"Key":key,"ContentType":ctype},
        ExpiresIn=3600
    )

# ---------------- EMBEDDINGS ----------------
def vector_to_bin(vec):
    return np.array(vec, dtype=np.float32).tobytes()

def bin_to_vector(b):
    return np.frombuffer(b, dtype=np.float32)

def index_text(source_id, text):
    try:
        emb = openai.Embedding.create(
            model="text-embedding-3-small",
            input=text
        )
        vec = emb["data"][0]["embedding"]
        db = get_db()
        rid = f"emb_{int(time.time()*1000)}"
        db.execute(
            "INSERT INTO embeddings (id,source_id,text,vector) VALUES (?,?,?,?)",
            (rid, source_id, text, vector_to_bin(vec))
        )
        db.commit()
        return rid
    except Exception as e:
        print("index error", e)
        return None

def search_context(query, k=3):
    try:
        emb = openai.Embedding.create(
            model="text-embedding-3-small",
            input=query
        )
        q = np.array(emb["data"][0]["embedding"], dtype=np.float32)
    except Exception as e:
        print("embedding error", e)
        return []
    db = get_db()
    rows = db.execute("SELECT * FROM embeddings").fetchall()
    if not rows: return []
    vecs = [bin_to_vector(r["vector"]) for r in rows]
    V = np.vstack(vecs)
    qn = q/(np.linalg.norm(q)+1e-9)
    Vn = V/(np.linalg.norm(V,axis=1,keepdims=True)+1e-9)
    sims = (Vn @ qn).tolist()
    idx = sorted(range(len(sims)), key=lambda i:sims[i], reverse=True)[:k]
    return [rows[i]["text"] for i in idx]

# ---------------- ROUTES ----------------

@app.route("/api/health")
def health():
    return jsonify({"ok":True})

@app.route("/api/auth/login", methods=["POST"])
def login():
    body = request.json
    user = body.get("username")
    pw = body.get("password")
    if user in DEMO_USERS and DEMO_USERS[user]["password"] == pw:
        t = make_jwt(user, DEMO_USERS[user]["role"])
        return jsonify({"token":t,"role":DEMO_USERS[user]["role"],"user":user})
    return jsonify({"error":"invalid credentials"}),401

@app.route("/api/presign", methods=["POST"])
def presign():
    if not AWS_BUCKET:
        return jsonify({"error":"s3_not_enabled"}),400
    b = request.json
    fname = b.get("filename")
    ctype = b.get("content_type","application/octet-stream")
    key = f"uploads/{int(time.time())}_{fname}"
    url = create_presigned_put(key, ctype)
    if not url: return jsonify({"error":"presign_failed"}),500
    public = f"https://{AWS_BUCKET}.s3.amazonaws.com/{key}"
    return jsonify({"upload_url":url, "public_url":public})

@app.route("/api/complaints", methods=["GET"])
def list_complaints():
    db = get_db()
    rows = db.execute("SELECT * FROM complaints ORDER BY created_at DESC").fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["tags"] = json.loads(d["tags"]) if d["tags"] else []
        out.append(d)
    return jsonify(out)

@app.route("/api/complaints", methods=["POST"])
def create_complaint():
    b = request.json
    cid = f"c_{int(time.time()*1000)}"
    title = b.get("title","").strip()
    if not title:
        return jsonify({"error":"title required"}),400

    db = get_db()
    db.execute(\"\"\"INSERT INTO complaints (id,created_at,name,roll,category,priority,title,description,status,tags,attachment_name,attachment_url)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)\"\"\", (
      cid,
      datetime.now(timezone.utc).isoformat(),
      b.get("name","Anonymous"),
      b.get("roll",""),
      b.get("category","Other"),
      b.get("priority","Normal"),
      title,
      b.get("description",""),
      "Submitted",
      json.dumps(b.get("tags",[])),
      b.get("attachment_name",""),
      b.get("attachment_url","")
    ))
    db.commit()

    try:
        txt = f\"{title}\\n{b.get('description','')}\"[:1500]
        index_text(cid, txt)
    except:
        pass

    return jsonify({"ok":True,"id":cid})

@app.route("/api/complaints/<cid>/resolve", methods=["POST"])
@require_role(["teacher","admin"])
def resolvec(cid):
    db = get_db()
    db.execute("UPDATE complaints SET status='Resolved' WHERE id=?", (cid,))
    db.execute("INSERT INTO resolved_history (ts) VALUES (?)", (datetime.now(timezone.utc).isoformat(),))
    db.commit()
    return jsonify({"ok":True})

@app.route("/api/stats/summary")
def summary():
    db = get_db()
    tot = db.execute("SELECT COUNT(*) c FROM complaints").fetchone()["c"]
    res = db.execute("SELECT COUNT(*) c FROM complaints WHERE status='Resolved'").fetchone()["c"]
    un = db.execute("SELECT COUNT(*) c FROM complaints WHERE status='Under Review'").fetchone()["c"]
    return jsonify({"total": tot, "resolved": res, "under": un, "open": tot - res})

@app.route("/api/chat", methods=["POST"])
def chat():
    b = request.json
    msgs = b.get("messages",[])
    user_msg = msgs[-1]["content"] if msgs else ""

    ctx_list = search_context(user_msg,3)
    ctx = "\\n\\n".join(ctx_list)

    def gen():
        try:
            stream = openai.ChatCompletion.create(
                model=os.getenv("OPENAI_MODEL","gpt-4o-mini"),
                stream=True,
                messages=[
                    {"role":"system","content":"You are AGM Complaint Hub AI support."},
                ] + ([{"role":"system","content":"Relevant context:\\n"+ctx}] if ctx else []) + msgs
            )
            for chunk in stream:
                delta = chunk.choices[0].delta
                if "content" in delta:
                    yield f"event: chunk\\ndata: {json.dumps({'text':delta['content']})}\\n\\n"
            yield "event: done\\ndata: {}\\n\\n"
        except Exception as e:
            yield f"event: error\\ndata: {json.dumps({'error': str(e)})}\\n\\n"

    return Response(gen(), mimetype="text/event-stream")

if __name__ == "__main__":
    print("Initializing DB...")
    init_db()
    port = int(os.getenv("PORT", "8000"))
    print(f"Running server on http://127.0.0.1:{port}")
    app.run(host="0.0.0.0", port=port, debug=True)
