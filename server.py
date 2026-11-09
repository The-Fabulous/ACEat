"""ACEat chat API and local preview. Run: python server.py."""
import json
import mimetypes
import os
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

from textbook_engine.client import LLMRequestError, load_config
from exam_source import get_paper, PaperSourceError
from book_source import get_book_pdf, byte_range, BookSourceError
from tutor_graph import CHAT_GRAPH, MAX_HISTORY_MESSAGES, TOPICS

ROOT = Path(__file__).resolve().parent
MAX_BODY = 64 * 1024
CHAT_SLOT = threading.BoundedSemaphore(1)
ALLOWED_ORIGINS = {"https://the-fabulous.github.io"}
ALLOWED_ORIGINS.update(origin.strip().rstrip("/") for origin in os.environ.get("CHAT_ALLOWED_ORIGINS", "").split(",") if origin.strip())
STATIC_FILES = {"index.html", "app.js", "chat.js", "exam.js", "library.js", "style.css", "exam.css", "library.css", "chat-config.js"}


def validate_chat(body):
    if not isinstance(body, dict):
        raise ValueError("Ожидается JSON-объект.")
    message, topic, history = body.get("message"), body.get("topic"), body.get("history", [])
    if not isinstance(message, str) or not 1 <= len(message.strip()) <= 3000:
        raise ValueError("Сообщение должно содержать от 1 до 3000 символов.")
    if not isinstance(topic, str) or topic not in TOPICS:
        raise ValueError("Выбери тему SAT.")
    if not isinstance(history, list):
        raise ValueError("Некорректная история диалога.")
    clean_history = []
    for item in history[-MAX_HISTORY_MESSAGES:]:
        if not isinstance(item, dict) or item.get("role") not in ("user", "assistant") or not isinstance(item.get("content"), str):
            raise ValueError("Некорректная история диалога.")
        if item["content"].strip():
            clean_history.append({"role": item["role"], "content": item["content"].strip()[:1200]})
    return {"message": message.strip(), "topic": topic, "history": clean_history}


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def allowed_origin(self):
        origin = self.headers.get("Origin")
        if not origin:
            return True
        # Local preview uses the same host. Remote Pages has an explicit origin.
        return origin in ALLOWED_ORIGINS or origin in {
            f"http://{self.headers.get('Host')}", f"https://{self.headers.get('Host')}"
        }

    def end_headers(self):
        origin = self.headers.get("Origin")
        if origin and self.allowed_origin():
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()

    def send_json(self, status, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        try:
            self.wfile.write(data)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_OPTIONS(self):
        path = urlsplit(self.path).path
        book_pdf = path.startswith("/api/books/") and path.endswith("/pdf")
        if path != "/api/chat" and not book_pdf:
            self.send_json(404, {"ok": False, "error": "Не найдено."})
            return
        if not self.allowed_origin():
            self.send_json(403, {"ok": False, "error": "Этот адрес сайта не разрешён."})
            return
        self.send_response(204)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS" if book_pdf else "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Range" if book_pdf else "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        path = unquote(urlsplit(self.path).path)
        if path == "/api/health":
            self.send_json(200, {"ok": True, "configured": bool(load_config()["OPENAI_API_KEY"])})
            return
        if path.startswith("/api/books/") and path.endswith("/pdf"):
            if not self.allowed_origin():
                self.send_json(403, {"ok": False, "error": "Этот адрес сайта не разрешён."})
                return
            try:
                source = get_book_pdf(path[len("/api/books/"):-len("/pdf")])
            except KeyError:
                self.send_json(404, {"ok": False, "error": "PDF учебника не найден."})
                return
            except BookSourceError:
                self.send_json(502, {"ok": False, "error": "Оригинальный PDF пока недоступен. Попробуй позже или открой источник."})
                return
            download = parse_qs(urlsplit(self.path).query).get("download") == ["1"]
            self.send_book_file(source, download)
            return
        if path.startswith("/api/papers/"):
            if not self.allowed_origin():
                self.send_json(403, {"ok": False, "error": "Этот адрес сайта не разрешён."})
                return
            try:
                data = get_paper(path.removeprefix("/api/papers/"))
            except KeyError:
                self.send_json(404, {"ok": False, "error": "Вариант не найден."})
                return
            except PaperSourceError:
                self.send_json(502, {"ok": False, "error": "Оригинальные задания временно недоступны."})
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            try:
                self.wfile.write(data)
            except (BrokenPipeError, ConnectionResetError):
                pass
            return
        relative = path.lstrip("/") or "index.html"
        parts = Path(relative).parts
        target = (ROOT / relative).resolve()
        allowed = relative in STATIC_FILES or (
            parts and parts[0] == "data" and target.suffix == ".json"
        )
        if not allowed or any(part.startswith(".") for part in parts) or not target.is_relative_to(ROOT) or not target.is_file():
            self.send_json(404, {"ok": False, "error": "Не найдено."})
            return
        data = target.read_bytes()
        self.send_response(200)
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_header("Content-Type", content_type + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_book_file(self, source, download):
        size = source.stat().st_size
        header = self.headers.get("Range")
        try:
            start, end = byte_range(header, size)
        except ValueError:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(206 if header else 200)
        self.send_header("Content-Type", "application/pdf")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range")
        self.send_header("Content-Disposition", f'{"attachment" if download else "inline"}; filename="{source.name}"')
        if header:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        try:
            with source.open("rb") as stream:
                stream.seek(start)
                remaining = end - start + 1
                while remaining:
                    chunk = stream.read(min(64 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def do_POST(self):
        if urlsplit(self.path).path != "/api/chat":
            self.send_json(404, {"ok": False, "error": "Не найдено."})
            return
        if not self.allowed_origin():
            self.send_json(403, {"ok": False, "error": "Этот адрес сайта не разрешён."})
            return
        if self.headers.get_content_type() != "application/json":
            self.send_json(415, {"ok": False, "error": "Ожидается application/json."})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 0 < length <= MAX_BODY:
                self.send_json(413, {"ok": False, "error": "Слишком большой или пустой запрос."})
                return
            state = validate_chat(json.loads(self.rfile.read(length)))
        except (ValueError, UnicodeError):
            self.send_json(400, {"ok": False, "error": "Проверь сообщение, тему и историю диалога."})
            return
        if not load_config()["OPENAI_API_KEY"]:
            self.send_json(503, {"ok": False, "error": "Помощник ещё не настроен. Попробуй позже."})
            return
        if not CHAT_SLOT.acquire(blocking=False):
            self.send_json(429, {"ok": False, "error": "Помощник занят. Попробуй через минуту."})
            return
        try:
            result = CHAT_GRAPH.invoke(state)
            self.send_json(200, {"ok": True, "answer": result["answer"]})
        except LLMRequestError as error:
            # The shared client sanitizes provider responses before raising.
            self.log_error("LLM request failed: %s", error)
            self.send_json(502, {"ok": False, "error": "Не удалось получить ответ ИИ. Попробуй повторить вопрос позже."})
        except Exception:
            self.log_error("Chat graph failed")
            self.send_json(500, {"ok": False, "error": "Ошибка помощника. Попробуй ещё раз."})
        finally:
            CHAT_SLOT.release()


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    host = "0.0.0.0" if "PORT" in os.environ else "127.0.0.1"
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"ACEat: http://{host}:{port}/#chat", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
