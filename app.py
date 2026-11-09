"""Vercel ASGI entrypoint. Local server.py remains available separately."""
import json
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response
from starlette.concurrency import run_in_threadpool

from book_source import BookSourceError, get_book_pdf
from exam_source import PaperSourceError, get_paper
from server import CHAT_SLOT, MAX_BODY, STATIC_FILES, validate_chat
from textbook_engine.client import LLMRequestError, load_config
from tutor_graph import CHAT_GRAPH

ROOT = Path(__file__).resolve().parent
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
origins = ["https://the-fabulous.github.io"]
origins.extend(origin.strip().rstrip("/") for origin in os.environ.get("CHAT_ALLOWED_ORIGINS", "").split(",") if origin.strip())
app.add_middleware(
    CORSMiddleware, allow_origins=origins, allow_methods=["GET", "HEAD", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Range"],
    expose_headers=["Accept-Ranges", "Content-Length", "Content-Range", "Content-Disposition"],
)


@app.middleware("http")
async def response_headers(request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


def failure(status, message):
    return JSONResponse({"ok": False, "error": message}, status_code=status)


@app.get("/api/health")
def health():
    return {"ok": True, "configured": bool(load_config()["OPENAI_API_KEY"]), "runtime": "vercel" if os.environ.get("VERCEL") else "asgi"}


def chat_answer(state):
    if not load_config()["OPENAI_API_KEY"]:
        return failure(503, "Помощник ещё не настроен. Попробуй позже.")
    if not CHAT_SLOT.acquire(blocking=False):
        return failure(429, "Помощник занят. Попробуй через минуту.")
    try:
        return {"ok": True, "answer": CHAT_GRAPH.invoke(state)["answer"]}
    except LLMRequestError:
        return failure(502, "Не удалось получить ответ ИИ. Попробуй повторить вопрос позже.")
    except Exception:
        return failure(500, "Ошибка помощника. Попробуй ещё раз.")
    finally:
        CHAT_SLOT.release()


@app.post("/api/chat")
async def chat(request: Request):
    if request.headers.get("content-type", "").split(";", 1)[0].strip() != "application/json":
        return failure(415, "Ожидается application/json.")
    data = bytearray()
    async for chunk in request.stream():
        data.extend(chunk)
        if len(data) > MAX_BODY:
            return failure(413, "Слишком большой запрос.")
    try:
        state = validate_chat(json.loads(data))
    except (ValueError, UnicodeError):
        return failure(400, "Проверь сообщение, тему и историю диалога.")
    return await run_in_threadpool(chat_answer, state)


@app.api_route("/api/books/{book_id}/pdf", methods=["GET", "HEAD"])
def book_pdf(book_id: str, download: int = 0):
    try:
        path = get_book_pdf(book_id)
    except KeyError:
        return failure(404, "PDF учебника не найден.")
    except BookSourceError:
        return failure(502, "Оригинальный PDF пока недоступен. Попробуй позже или открой источник.")
    # ASGI streams the file; no whole-book response buffer. FileResponse handles Range.
    return FileResponse(path, media_type="application/pdf", filename=path.name,
                        content_disposition_type="attachment" if download == 1 else "inline")


@app.get("/api/papers/{exam_id}")
def paper_pdf(exam_id: str):
    try:
        data = get_paper(exam_id)
    except KeyError:
        return failure(404, "Вариант не найден.")
    except PaperSourceError:
        return failure(502, "Оригинальные задания временно недоступны.")
    return Response(data, media_type="application/pdf")


@app.api_route("/{path:path}", methods=["GET", "HEAD"])
def website(path: str):
    relative = path or "index.html"
    parts = Path(relative).parts
    target = (ROOT / relative).resolve()
    allowed = relative in STATIC_FILES or relative == "auth-config.js" or (
        bool(parts) and parts[0] == "data" and target.suffix == ".json"
    )
    if not allowed or any(part.startswith(".") for part in parts) or not target.is_relative_to(ROOT) or not target.is_file():
        return failure(404, "Не найдено.")
    response = FileResponse(target)
    if target.suffix in (".html", ".js", ".json"):
        response.headers["Cache-Control"] = "no-cache"
    return response
