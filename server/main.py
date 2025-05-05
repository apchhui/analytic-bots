from fastapi import FastAPI
from pydantic import BaseModel
from typing import Optional
from datetime import datetime, timedelta, timezone
import psycopg2
import re
import threading
import time
from fastapi.responses import JSONResponse
import subprocess

usernames = ['beliberdanka']
slots = []

app = FastAPI()

conn = psycopg2.connect(
    dbname="datametry",
    user="apchhui",
    password="1337",
    host="localhost"
)
cursor = conn.cursor()

cursor.execute("""
    CREATE TABLE IF NOT EXISTS players (
        id SERIAL PRIMARY KEY,
        nickname TEXT UNIQUE,
        privilege TEXT,
        clan TEXT,
        suffix TEXT
    )
""")

cursor.execute("""
    CREATE TABLE IF NOT EXISTS messages (
        id SERIAL PRIMARY KEY,
        player_id INTEGER REFERENCES players(id) ON DELETE CASCADE,
        message TEXT,
        timestamp TIMESTAMPTZ DEFAULT now()
    )
""")

cursor.execute("""
    CREATE TABLE IF NOT EXISTS items (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ DEFAULT now(),
        item TEXT,
        count INTEGER,
        price REAL,
        seller TEXT
    )
""")

conn.commit()

JS_PATH = '/home/apchhui/workspace/funtime/bot/main.js'

class MessageRequest(BaseModel):
    text: str

class SearchRequest(BaseModel):
    search_term: str
    seconds: int = 3600
    nickname: Optional[str] = None

class StatRequest(BaseModel):
    item: str
    count: int
    seller: Optional[str]
    price: float

def parse_message(text):
    result = {'clan': None, 'privilege': None, 'nickname': None, 'suffix': None}

    text = re.sub(r'^[^\w<\[{]+', '', text).strip()

    pattern = re.compile(
        r'^(?:<(?P<clan>[^<>]+)>\s*)?'
        r'(?:\[(?P<priv1>[^\[\]]+)\]|\{(?P<priv2>[^\{\}]+)\})\s+'
        r'(?P<nickname>\S+)'
        r'(?:\s+(?P<suffix>.+))?$'
    )

    match = pattern.match(text)
    if match:
        result['clan'] = match.group('clan')
        result['privilege'] = match.group('priv1') or match.group('priv2')
        result['nickname'] = match.group('nickname')
        result['suffix'] = match.group('suffix')

    return result


def auto_cleanup_old_messages(interval_seconds=60):
    while True:
        try:
            now_utc = datetime.now(timezone.utc)
            cutoff = now_utc - timedelta(days=3)
            cursor.execute("DELETE FROM messages WHERE timestamp < %s", (cutoff,))
            conn.commit()
            print(f"[{now_utc}] Старые сообщения удалены до {cutoff}")
        except Exception as e:
            print(f"[!] Ошибка при удалении: {e}")
        time.sleep(interval_seconds)

thread = threading.Thread(target=auto_cleanup_old_messages, daemon=True)
thread.start()

@app.post("/message/")
async def save_message(request: MessageRequest):
    timestamp = datetime.now(timezone.utc)
    try:
        raw_prefix, text = request.text.split('⇨', 1)
    except ValueError:
        return {"status": "error", "msg": "Invalid message format. Expected ⇨ separator."}

    data = parse_message(raw_prefix)
    print(data)
    nickname = data['nickname']
    clan = data['clan']
    privilege = data['privilege']
    suffix = data['suffix']

    cursor.execute("""
        INSERT INTO players (nickname, privilege, clan, suffix)
        VALUES (%s, %s, %s, %s)
        ON CONFLICT (nickname) DO UPDATE SET
            privilege = EXCLUDED.privilege,
            clan = EXCLUDED.clan,
            suffix = EXCLUDED.suffix
        RETURNING id
    """, (nickname, privilege, clan, suffix))

    player_id = cursor.fetchone()[0]

    cursor.execute("""
        INSERT INTO messages (player_id, message, timestamp)
        VALUES (%s, %s, %s)
    """, (player_id, text.strip(), timestamp))

    conn.commit()

    return {"status": "saved", "msg": text.strip()}

@app.post("/search/")
async def search_messages(req: SearchRequest):
    time_threshold = datetime.now(timezone.utc) - timedelta(seconds=req.seconds)
    if len(req.search_term) > 100:
        return {"error": "Search term too long"}
    pattern = f"%{req.search_term.lower()}%"

    if req.nickname:
        cursor.execute("""
            SELECT m.timestamp, p.nickname, m.message FROM messages m
            JOIN players p ON m.player_id = p.id
            WHERE m.timestamp >= %s AND p.nickname = %s AND LOWER(m.message) LIKE %s
            ORDER BY m.timestamp ASC
        """, (time_threshold, req.nickname, pattern))
    else:
        cursor.execute("""
            SELECT m.timestamp, p.nickname, m.message FROM messages m
            JOIN players p ON m.player_id = p.id
            WHERE m.timestamp >= %s AND LOWER(m.message) LIKE %s
            ORDER BY m.timestamp ASC
        """, (time_threshold, pattern))

    result = cursor.fetchall()
    messages = [
        f"[{ts.astimezone().strftime('%Y-%m-%d %H:%M:%S')}] {nick}: {msg}"
        for ts, nick, msg in result
    ]
    return {"matches": messages, "count": len(messages)}

@app.post("/item/")
async def stat(request: StatRequest):
    try:
        cursor.execute("""
            INSERT INTO items (timestamp, item, count, price, seller)
            VALUES (%s, %s, %s, %s, %s)
        """, (datetime.now(timezone.utc), request.item, request.count, request.price, request.seller))
        conn.commit()
    except Exception as e:
        print(f'[ERROR] {e}')
        return {'status': 400}
    return {'status': 200}

@app.get("/item/")
async def data():
    cursor.execute("SELECT * FROM items")
    rows = cursor.fetchall()
    data = [
        {   
            "id": row[0],
            "timestamp": row[1].isoformat(),
            "item": row[2],
            "count": row[3],
            "price": row[4],
            "seller": row[5]
        } for row in rows
    ]
    return JSONResponse(content=data)

@app.get('/start/')
async def start():
    return 'Боты запущены(aga)'
