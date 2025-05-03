from fastapi import FastAPI
from pydantic import BaseModel
import redis
import time
import threading
import uuid
from typing import Optional
from clickhouse_driver import Client
from datetime import datetime

app = FastAPI()
r = redis.Redis(host='localhost', port=6379, decode_responses=True)

client = Client(host='localhost')

client.execute("CREATE DATABASE IF NOT EXISTS telemetry")

client.execute("""
    CREATE TABLE IF NOT EXISTS telemetry.items (
        timestamp DateTime,
        item String,
        count UInt32,
        price Float32,
        seller Nullable(String)
    ) ENGINE = MergeTree()
    ORDER BY (item, timestamp)
""")

EXPIRATION_SECONDS = 72 * 60 * 60
CLEANUP_INTERVAL = 60

class MessageRequest(BaseModel):
    text: str

class SearchRequest(BaseModel):
    search_term: str

class StatRequest(BaseModel):
    item: str
    count: int
    seller: Optional[str]
    price: float

def error(message):
    print(f'[ERROR] {message}')

def cleanup_old_messages():
    while True:
        now = int(time.time())
        threshold = now - EXPIRATION_SECONDS
        print(f"Текущее время: {now}, Порог времени для удаления: {threshold}")
        removed = r.zremrangebyscore("messages", "-inf", threshold)
        if removed:
            print(f"Удалено {removed} старых сообщений")
        else:
            print("Не удалено ни одного сообщения")
        time.sleep(CLEANUP_INTERVAL)

def redis_listener():
    p = r.pubsub()
    p.psubscribe("__keyspace@0__:messages")
    for msg in p.listen():
        print("Событие:", msg)

threading.Thread(target=cleanup_old_messages, daemon=True).start()
threading.Thread(target=redis_listener, daemon=True).start()

@app.post("/message/")
async def save_message(request: MessageRequest):
    timestamp = int(time.time())
    unique_id = str(uuid.uuid4())
    message_key = f"{unique_id}:{request.text}"
    r.zadd("messages", {message_key: timestamp})
    return {"status": "saved", "msg": message_key}

@app.post("/search/")
async def search_messages(req: SearchRequest):
    all_messages = r.zrange("messages", 0, -1)
    result = [msg for msg in all_messages if req.search_term.lower() in msg.lower()]
    return {"matches": result}

@app.post('/item/')
async def stat(request: StatRequest):
    try:
        item = request.item
        count = request.count
        seller = request.seller
        price = request.price

        client.execute(
            'INSERT INTO telemetry.items VALUES',
            [[
                datetime.now(), 
                item, 
                count, 
                price,
                seller
            ]]
        )
        print(f'Записано: предмет {item}, кол-во {count}, продавец {None if seller is None else seller}, цена {price}$')
    except Exception as e:
        error(e)
        return {'status': 400}
    return {'status': 200}