from fastapi import FastAPI
from fastapi import Request
from fastapi import Query
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional, List
from datetime import datetime, timedelta, timezone
import psycopg2
import re
import threading
import time
from fastapi.responses import JSONResponse
import subprocess
import asyncio
import os

usernames = [
    'beliberdanka'
]

# , 'beliberdanok', 'beliberdanische', 'beliberdanchik',
#     'beliberdanus', 'belibErdan4ik', 'beliberdanoid'

slots = [12, 13, 14, 15, 20, 21, 22, 23, 24, 29, 30, 31, 32, 33]
anarchy = [
    102, 103, 104, 105, 106, 107, 108, 109, 110, 111,
    203, 204, 205, 206, 207, 208, 209, 210, 211, 212, 213, 214, 215, 216, 217, 218, 219, 220, 221, 222, 223, 224, 225, 226, 227, 228, 229, 230,
    302, 303, 304, 305, 306, 307, 308, 309, 310, 311, 312, 313, 314, 315, 316, 317,
    502, 503, 504, 505, 506, 507, 508, 509, 510,
    602, 603, 604, 605
]


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
    CREATE TABLE IF NOT EXISTS formatted_items (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ NOT NULL,
        item TEXT UNIQUE,
        median INT,
        allCount INT,
        midPrice INT,
        TheMostPrice INT,
        TheMostSeller TEXT
    )
""")

cursor.execute("""
    CREATE TABLE IF NOT EXISTS items (
        id SERIAL PRIMARY KEY,
        timestamp TIMESTAMPTZ DEFAULT now(),
        item TEXT,
        count INTEGER,
        price REAL,
        seller TEXT,
        name TEXT,
        rname TEXT
    )
""")

conn.commit()

JS_PATH = '/home/apchhui/workspace/funtime/bot/main.js'


class ResultsRequest(BaseModel):
    timestamp: datetime | None = None
    item: str
    median: int
    allCount: int
    midPrice: int
    TheMostPrice: int
    TheMostSeller: str

class MessageRequest(BaseModel):
    text: str

class SearchRequest(BaseModel):
    search_term: str
    seconds: int = 3600
    nickname: Optional[str] = None

class StatRequest(BaseModel):
    item: Optional[str] = None
    count: Optional[int] = None
    price: Optional[int] = None
    seller: Optional[str] = None
    name: Optional[str] = None
    rname: Optional[str] = None


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
            INSERT INTO items (timestamp, item, count, price, seller, name, rname)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
        """, (
            datetime.now(timezone.utc),
            request.item,
            request.count,
            request.price,
            request.seller,
            request.name,
            request.rname
        ))
        conn.commit()
    except Exception as e:
        print(f'[ERROR] {e}')
        return {'status': 400}
    return {'status': 200}

@app.get('/item/')
async def items():
    try:
        cursor.execute('SELECT * FROM items')
        data = cursor.fetchall()
        return {'status': 200, 'data': data}
    except Exception as e:
        print(f'An error occured {e}')
        return {'status': 429}

@app.post("/results/")
async def insert_bulk_results(results: List[ResultsRequest]):
    try:
        for r in results:
            cursor.execute("""
                INSERT INTO formatted_items (timestamp, item, median, allCount, midPrice, TheMostPrice, TheMostSeller)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                ON CONFLICT (item) DO UPDATE SET
                    timestamp = EXCLUDED.timestamp,
                    median = EXCLUDED.median,
                    allCount = EXCLUDED.allCount,
                    midPrice = EXCLUDED.midPrice,
                    TheMostPrice = EXCLUDED.TheMostPrice,
                    TheMostSeller = EXCLUDED.TheMostSeller
            """, (
                r.timestamp or datetime.now(timezone.utc),
                r.item,
                r.median,
                r.allCount,
                r.midPrice,
                r.TheMostPrice,
                r.TheMostSeller
            ))
        conn.commit()
        return {"status": "success"}
    except Exception as e:
        conn.rollback()  # <- обязательно
        print(f"[ERROR] /results/: {e}")
        return {"status": "error", "detail": str(e)}

@app.get('/start/')
async def start():
    processes = []
    js_dir = os.path.dirname(JS_PATH)

    for i, nick in enumerate(usernames):
        proc = subprocess.Popen(
            ['node', JS_PATH, nick, str(slots[i]), str(anarchy[i])],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            cwd=js_dir
        )
        processes.append((nick, proc))

    async def read_output(nick, proc):
        while True:
            line = await asyncio.to_thread(proc.stdout.readline)
            if not line:
                break
            print(f"[{nick}] {line.strip()}")

    for nick, proc in processes:
        asyncio.create_task(read_output(nick, proc))

    return 'Боты запущены'

@app.get('/items/')
async def get_filtered_items(
    item: Optional[str] = Query(None),
    seller: Optional[str] = Query(None)
):
    try:
        query = "SELECT * FROM formatted_items"
        params = []

        if item and seller:
            query += " WHERE item = %s AND seller = %s"
            params.extend([item, seller])
        elif item:
            query += " WHERE item = %s"
            params.append(item)
        elif seller:
            query += " WHERE seller = %s"
            params.append(seller)

        cursor.execute(query, tuple(params))
        data = cursor.fetchall()
        return {'status': 200, 'data': data}
    except Exception as e:
        print(f'An error occurred: {e}')
        return {'status': 500, 'error': str(e)}
