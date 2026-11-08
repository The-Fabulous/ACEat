"""Loopback-only editorial panel. Public GitHub Pages remains entirely static."""
from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import re
import secrets
import threading
from urllib.parse import unquote, urlsplit
import uuid
import webbrowser

from tools import library

MAX_PDF = 25 * 1024 * 1024


class LibraryServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, port=4174, root=library.ROOT, engine_dir=None):
        super().__init__(("127.0.0.1", port), Handler)
        self.root = Path(root).resolve()
        self.engine_dir = engine_dir
        self.token = secrets.token_urlsafe(32)
        self.job = None
        self.operation = threading.Lock()

    def engine_status(self):
        try:
            modules = library.load_engine(self.engine_dir)
            return {"engine_ready": True, "key_ready": bool(modules["tutor_graph"].load_config()["OPENAI_API_KEY"]), "engine": library.engine_info(modules)}
        except library.ImportFailure as error:
            return {"engine_ready": False, "key_ready": False, "error": str(error)}

    def run_import(self, job, path, metadata):
        try:
            job.update(status="running")
            entry = library.import_pdf(path, metadata, root=self.root, engine_dir=self.engine_dir, progress=lambda **values: job.update(values))
            job.update(status="completed", entry=entry, message="Учебник добавлен в локальный сборник. Откройте его и проверьте перед публикацией.")
        except library.ImportFailure as error:
            job.update(status="failed", message=str(error))
        except Exception:
            job.update(status="failed", message="Обработка не завершена. Каталог не изменён; проверьте доступность движка и повторите запуск.")
        finally:
            path.unlink(missing_ok=True)
            self.operation.release()


class Handler(BaseHTTPRequestHandler):
    server: LibraryServer

    def send_json(self, status, data):
        content = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def trusted_host(self):
        port = self.server.server_port
        return self.headers.get("Host") in (f"127.0.0.1:{port}", f"localhost:{port}")

    def authorize(self):
        origin = self.headers.get("Origin")
        expected = f"http://{self.headers.get('Host')}"
        token = self.headers.get("X-ACEat-Token", "")
        if not self.trusted_host() or origin != expected or not secrets.compare_digest(token, self.server.token):
            self.send_json(403, {"error": "Запрос разрешён только из локальной панели ACEat."})
            return False
        return True

    def do_GET(self):
        if not self.trusted_host():
            self.send_json(403, {"error": "Недопустимый адрес панели."})
            return
        path = unquote(urlsplit(self.path).path)
        if path == "/api/status":
            self.send_json(200, {"local": True, "token": self.server.token, **self.server.engine_status(), "job": self.server.job})
            return
        if re.fullmatch(r"/api/imports/[a-f0-9]{32}", path):
            job = self.server.job
            self.send_json(200 if job and job["id"] == path.rsplit("/", 1)[1] else 404, job if job and job["id"] == path.rsplit("/", 1)[1] else {"error": "Задача не найдена."})
            return
        allowed = {"/": "index.html", "/index.html": "index.html", "/manage.html": "manage.html", "/app.js": "app.js", "/manage.js": "manage.js", "/style.css": "style.css", "/data/catalog.json": "data/catalog.json"}
        relative = allowed.get(path)
        if relative is None and re.fullmatch(r"/data/books/[a-z][a-z0-9-]{0,63}-[a-f0-9]{12}\.json", path):
            relative = path[1:]
        if relative is None:
            self.send_error(404)
            return
        try:
            content = (self.server.root / relative).read_bytes()
        except OSError:
            self.send_error(404)
            return
        mime = {".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json"}[Path(relative).suffix]
        self.send_response(200)
        self.send_header("Content-Type", mime + "; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(content)

    def do_POST(self):
        if not self.authorize():
            return
        if self.path not in ("/api/imports", "/api/publish"):
            self.send_json(404, {"error": "Неизвестная операция."})
            return
        if not self.server.operation.acquire(blocking=False):
            self.send_json(409, {"error": "Другая операция ещё выполняется."})
            return
        asynchronous = False
        try:
            if self.path == "/api/publish":
                result = library.publish_library(self.server.root)
                self.send_json(200, result)
                return
            if self.headers.get("Content-Type") != "application/pdf":
                raise library.ImportFailure("Выберите PDF-файл.")
            try:
                length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                length = 0
            if not 0 < length <= MAX_PDF:
                raise library.ImportFailure("Размер PDF должен быть от 1 байта до 25 МБ.")
            raw_metadata = self.headers.get("X-ACEat-Metadata", "")
            if len(raw_metadata) > 12000:
                raise library.ImportFailure("Слишком длинное описание учебника.")
            try:
                metadata = library.validate_options(json.loads(unquote(raw_metadata)))
            except (ValueError, TypeError):
                raise library.ImportFailure("Проверьте поля формы и номера страниц.")
            status = self.server.engine_status()
            if not status["engine_ready"] or not status["key_ready"]:
                raise library.ImportFailure(status.get("error", "Добавьте ключ AI в локальный .env."))
            content = self.rfile.read(length)
            if len(content) != length or not content.startswith(b"%PDF-"):
                raise library.ImportFailure("Файл не является корректным PDF.")
            folder = self.server.root / ".local/uploads"
            folder.mkdir(parents=True, exist_ok=True)
            job = {"id": uuid.uuid4().hex, "status": "queued", "message": "PDF принят. Подготавливаем обработку…", "completed": 0, "total": 0}
            path = folder / f"{job['id']}.pdf"
            path.write_bytes(content)
            self.server.job = job
            thread = threading.Thread(target=self.server.run_import, args=(job, path, metadata), daemon=True)
            thread.start()
            asynchronous = True
            self.send_json(202, dict(job))
        except library.ImportFailure as error:
            self.send_json(400, {"error": str(error)})
        except Exception:
            self.send_json(500, {"error": "Не удалось выполнить операцию. Проверьте доступ к файлам и GitHub."})
        finally:
            if not asynchronous:
                self.server.operation.release()

    def setup(self):
        super().setup()
        self.connection.settimeout(30)


def main():
    parser = argparse.ArgumentParser(description="ACEat local textbook import panel")
    parser.add_argument("--port", type=int, default=4174)
    parser.add_argument("--engine-dir", type=Path)
    parser.add_argument("--no-browser", action="store_true")
    args = parser.parse_args()
    with LibraryServer(args.port, engine_dir=args.engine_dir) as server:
        url = f"http://127.0.0.1:{server.server_port}/manage.html"
        print(f"ACEat library: {url}", flush=True)
        if not args.no_browser:
            webbrowser.open(url)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
