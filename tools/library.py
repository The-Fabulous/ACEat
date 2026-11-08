"""Build ACEat textbook pages with the engine bundled in this repository."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

from textbook_engine import contents, pages, excerpts, client

ENGINE = {"extract_book_contents": contents, "generate_topic_pages": pages, "import_book": excerpts, "tutor_graph": client}

ROOT = Path(__file__).resolve().parents[1]
ID_PATTERN = re.compile(r"[a-z][a-z0-9-]{0,63}\Z")
BOOK_PATH = re.compile(r"\./data/books/[a-z][a-z0-9-]{0,63}-[0-9a-f]{12}\.json\Z")
FIELDS = ("paragraphs", "formulas", "steps", "key_points")
MAX_PAGES = 500


class ImportFailure(ValueError):
    """A message suitable for the local editor UI, without provider responses."""


def atomic_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temporary = tempfile.mkstemp(prefix=".aceat-", dir=path.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(data, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
        os.replace(temporary, path)
    finally:
        Path(temporary).unlink(missing_ok=True)


@contextmanager
def editorial_lock(root: Path):
    folder = root / ".local"
    folder.mkdir(exist_ok=True)
    path = folder / "library.lock"
    stream = path.open("a+b")
    locked = False
    try:
        # OS locks are released even if the panel is closed during generation.
        if os.name == "nt":
            import msvcrt
            stream.seek(0, os.SEEK_END)
            if stream.tell() == 0:
                stream.write(b"0")
                stream.flush()
            stream.seek(0)
            try:
                msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as error:
                raise ImportFailure("Другая операция с библиотекой ещё выполняется.") from error
        else:
            import fcntl
            try:
                fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                raise ImportFailure("Другая операция с библиотекой ещё выполняется.") from error
        locked = True
        yield
    finally:
        if locked:
            if os.name == "nt":
                stream.seek(0)
                msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        stream.close()


def engine_info() -> dict:
    folder = ROOT / "textbook_engine"
    digest = hashlib.sha256()
    for filename in ("contents.py", "pages.py", "excerpts.py", "client.py"):
        digest.update((folder / filename).read_bytes())
    return {"name": "ACEat Book Engine", "revision": digest.hexdigest()[:12], "based_on": "Classifi 93d232d"}


def read_catalog(root: Path) -> dict:
    try:
        catalog = json.loads((root / "data/catalog.json").read_text(encoding="utf-8-sig"))
    except (OSError, ValueError) as error:
        raise ImportFailure("Не удалось прочитать data/catalog.json. Существующий каталог не изменён.") from error
    if not isinstance(catalog, dict) or any(not isinstance(catalog.get(key), list) for key in ("textbooks", "pastExams", "challengeExams")):
        raise ImportFailure("Каталог должен содержать массивы textbooks, pastExams и challengeExams.")
    if any(not isinstance(item, dict) or not isinstance(item.get("title"), str) for key in ("textbooks", "pastExams", "challengeExams") for item in catalog[key]):
        raise ImportFailure("В каталоге есть некорректные записи. Импорт остановлен.")
    return catalog


def validate_options(options: dict) -> dict:
    result = dict(options)
    if not isinstance(result.get("id"), str) or not ID_PATTERN.fullmatch(result["id"]):
        raise ImportFailure("ID: от 1 до 64 строчных латинских букв, цифр и дефисов, начинается с буквы.")
    for key, limit in (("title", 160), ("author", 160), ("description", 1000)):
        value = result.get(key, "")
        if not isinstance(value, str) or len(value) > limit or (key == "title" and not value.strip()):
            raise ImportFailure(f"Некорректное поле {key} (лимит {limit} символов).")
        result[key] = value.strip()
    if result.get("subject") not in ("math", "reading", "mixed") or result.get("mode") not in ("contents", "pages"):
        raise ImportFailure("Выберите направление и режим обработки.")
    for key in ("start_page", "end_page"):
        if type(result.get(key)) is not int:
            raise ImportFailure("Номера страниц должны быть целыми числами.")
    start, end = result["start_page"], result["end_page"]
    if start < 1 or end < start or end - start + 1 > MAX_PAGES:
        raise ImportFailure(f"Укажите корректный диапазон до {MAX_PAGES} страниц PDF.")
    if result["mode"] == "pages" and result["subject"] != "math":
        raise ImportFailure("Обработка текста страниц в драйвере предназначена для Math. Для других направлений выберите оглавление.")
    result["replace"] = result.get("replace") is True
    return result


def validate_chapter(chapter: dict) -> None:
    if not isinstance(chapter, dict) or not isinstance(chapter.get("title"), str) or not chapter["title"].strip():
        raise ImportFailure("Движок вернул главу без названия.")
    if not isinstance(chapter.get("overview", ""), str) or not isinstance(chapter.get("sections"), list) or not chapter["sections"]:
        raise ImportFailure("Движок вернул пустую главу.")
    for section in chapter["sections"]:
        if not isinstance(section, dict) or not isinstance(section.get("heading"), str) or not section["heading"].strip():
            raise ImportFailure("Некорректный раздел главы.")
        if any(not isinstance(section.get(field), list) or any(not isinstance(text, str) for text in section[field]) for field in FIELDS):
            raise ImportFailure("Некорректное содержимое раздела главы.")
        if not any(text.strip() for field in FIELDS for text in section[field]):
            raise ImportFailure("Движок вернул раздел без учебного материала.")


def import_pdf(pdf_path: Path, options: dict, root: Path = ROOT, progress=lambda **kwargs: None) -> dict:
    options = validate_options(options)
    modules = ENGINE
    if not modules["tutor_graph"].load_config()["OPENAI_API_KEY"]:
        raise ImportFailure("Не настроен ключ AI. Добавьте его в ACEat/.env или переменную среды OPENAI_API_KEY.")
    with editorial_lock(root):
        catalog = read_catalog(root)
        previous = next((item for item in catalog["textbooks"] if item.get("id") == options["id"]), None)
        if previous and not options["replace"]:
            raise ImportFailure("Учебник с таким ID уже существует. Выберите другой ID или включите замену.")
        try:
            with modules["extract_book_contents"].pymupdf.open(pdf_path) as document:
                if document.needs_pass:
                    raise ImportFailure("PDF защищён паролем. Подготовьте доступную копию.")
                if options["end_page"] > document.page_count:
                    raise ImportFailure(f"В PDF только {document.page_count} страниц.")
                if any(not document[number - 1].get_text().strip() for number in range(options["start_page"], options["end_page"] + 1)):
                    raise ImportFailure("В выбранных страницах нет текста. Для сканов сначала выполните OCR.")
        except ImportFailure:
            raise
        except Exception as error:
            raise ImportFailure("Не удалось открыть PDF. Проверьте файл.") from error
        digest = hashlib.sha256(pdf_path.read_bytes()).hexdigest()
        signature = hashlib.sha256(json.dumps({"pdf": digest, "options": options, "engine": engine_info()}, sort_keys=True).encode()).hexdigest()
        cache = root / ".local/cache" / signature
        cache.mkdir(parents=True, exist_ok=True)
        try:
            if options["mode"] == "contents":
                progress(completed=0, total=0, message="Извлекаем оглавление PDF…")
                contents = modules["extract_book_contents"].create_book_contents(pdf_path, options["start_page"], options["end_page"])
                topics = contents["topics"]
                if not topics or len(topics) > 80:
                    raise ImportFailure("В оглавлении должно быть от 1 до 80 глав. Уточните диапазон страниц.")
                chapters = []
                for index, topic in enumerate(topics):
                    topic = {"topic": topic["topic"], "subtopics": topic["subtopics"] or [topic["topic"]]}
                    if len(topic["subtopics"]) > 80:
                        raise ImportFailure("В одной главе слишком много подтем. Обработайте меньший диапазон оглавления.")
                    progress(completed=index, total=len(topics), message=f"Глава {index + 1}: {topic['topic']}")
                    checkpoint = cache / f"chapter-{index}.json"
                    chapter = None
                    if checkpoint.is_file():
                        try:
                            candidate = json.loads(checkpoint.read_text(encoding="utf-8"))
                            validate_chapter(candidate)
                            if candidate["title"] == topic["topic"]:
                                chapter = candidate
                        except (ValueError, OSError):
                            pass
                    if chapter is None:
                        chapter = modules["generate_topic_pages"].generate_article(topic, f"chapter-{index + 1}")
                        validate_chapter(chapter)
                        atomic_json(checkpoint, chapter)
                    chapters.append(chapter)
                    progress(completed=index + 1, total=len(topics), message=f"Готово глав: {index + 1} из {len(topics)}")
            else:
                progress(completed=0, total=1, message="Разбираем текст выбранных страниц…")
                checkpoint = cache / "excerpt.json"
                if checkpoint.is_file():
                    chapter = json.loads(checkpoint.read_text(encoding="utf-8"))
                else:
                    chapter = modules["import_book"].create_article({"article_id": options["id"], "title": options["title"], "overview": options["description"], "start_page": options["start_page"], "end_page": options["end_page"], "chunk_size": 4}, pdf_path)
                validate_chapter(chapter)
                atomic_json(checkpoint, chapter)
                chapters = [chapter]
                progress(completed=1, total=1, message="Учебный материал готов.")
        except ImportFailure:
            raise
        except modules["tutor_graph"].LLMRequestError as error:
            raise ImportFailure("AI не завершил генерацию. Проверьте ключ, квоту и соединение. Готовые главы сохранены локально; повторите импорт с теми же параметрами.") from error
        except (ValueError, OSError) as error:
            raise ImportFailure("Не удалось обработать книгу. Проверьте диапазон страниц и нумерацию оглавления; для Math можно выбрать обработку текста.") from error
        source_name = Path(options.get("filename", pdf_path.name)).name[:180]
        page_range = f"{options['start_page']}–{options['end_page']}"
        source = f"{source_name}, страницы PDF {page_range}"
        book = {"format": "aceat.classifi-book.v1", "id": options["id"], "title": options["title"], "author": options["author"], "subject": options["subject"], "overview": options["description"], "source": source, "generation_mode": options["mode"], "engine": engine_info(), "created_at": datetime.now(timezone.utc).isoformat(), "chapters": chapters}
        content_hash = hashlib.sha256(json.dumps(book, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]
        relative_path = f"./data/books/{options['id']}-{content_hash}.json"
        entry = {"id": options["id"], "title": options["title"], "author": options["author"], "subject": options["subject"], "description": options["description"], "source": source, "chapter_count": len(chapters), "format": "classifi", "book_path": relative_path, "url": f"#book/{options['id']}"}
        catalog["textbooks"] = [entry if item.get("id") == options["id"] else item for item in catalog["textbooks"]]
        if previous is None:
            catalog["textbooks"].append(entry)
        output_path = root / relative_path.removeprefix("./")
        atomic_json(output_path, book)
        try:
            atomic_json(root / "data/catalog.json", catalog)
        except OSError:
            output_path.unlink(missing_ok=True)
            raise
        return entry


def publish_library(root: Path = ROOT) -> dict:
    """Publish only the catalog and referenced generated JSON, never the source PDFs."""
    def git(*args):
        return subprocess.run(["git", "-C", str(root), *args], capture_output=True, text=True, encoding="utf-8", timeout=60)
    with editorial_lock(root):
        if git("branch", "--show-current").stdout.strip() != "main":
            raise ImportFailure("Для публикации переключитесь на ветку main.")
        if git("remote", "get-url", "origin").stdout.strip().lower() not in ("https://github.com/the-fabulous/aceat.git", "git@github.com:the-fabulous/aceat.git"):
            raise ImportFailure("Origin не указывает на The-Fabulous/ACEat. Публикация остановлена.")
        if git("diff", "--cached", "--name-only").stdout.strip():
            raise ImportFailure("В Git уже есть подготовленные изменения. Сначала завершите их отдельно.")
        catalog = read_catalog(root)
        files = ["data/catalog.json"]
        for item in catalog["textbooks"]:
            if item.get("format") != "classifi":
                continue
            path = item.get("book_path", "")
            if not isinstance(path, str) or not BOOK_PATH.fullmatch(path):
                raise ImportFailure("Некорректный путь подготовленного учебника.")
            try:
                book = json.loads((root / path[2:]).read_text(encoding="utf-8"))
                if book["format"] != "aceat.classifi-book.v1" or book["id"] != item["id"] or not book["chapters"]:
                    raise ValueError()
                for chapter in book["chapters"]:
                    validate_chapter(chapter)
            except (OSError, ValueError, KeyError, TypeError) as error:
                raise ImportFailure("Один из учебников повреждён. Публикация остановлена.") from error
            files.append(path[2:])
        if git("add", "--", *files).returncode:
            raise ImportFailure("Не удалось подготовить библиотеку к коммиту.")
        if git("diff", "--cached", "--quiet").returncode == 1:
            if git("commit", "-m", "Publish textbook library").returncode:
                raise ImportFailure("Не удалось создать коммит. Проверьте настройки Git.")
        if git("push", "origin", "main").returncode:
            raise ImportFailure("Push не завершён. Данные сохранены локально. Проверьте доступ к GitHub и синхронизацию ветки main, затем повторите публикацию.")
        return {"url": "https://the-fabulous.github.io/ACEat/#textbooks", "commit": git("rev-parse", "HEAD").stdout.strip()}


def main() -> int:
    parser = argparse.ArgumentParser(description="Build an ACEat textbook page from a PDF. All processing code is bundled locally.")
    parser.add_argument("pdf", type=Path)
    parser.add_argument("--id", required=True)
    parser.add_argument("--title", required=True)
    parser.add_argument("--author", default="")
    parser.add_argument("--description", default="")
    parser.add_argument("--subject", choices=["math", "reading", "mixed"], default="math")
    parser.add_argument("--mode", choices=["contents", "pages"], default="contents")
    parser.add_argument("--start-page", type=int, required=True)
    parser.add_argument("--end-page", type=int, required=True)
    parser.add_argument("--publish", action="store_true", help="Commit generated library files and push to GitHub Pages after a successful build.")
    parser.add_argument("--replace", action="store_true")
    args = vars(parser.parse_args())
    pdf, publish = args.pop("pdf"), args.pop("publish")
    args["filename"] = pdf.name
    try:
        entry = import_pdf(pdf, args, progress=lambda **status: print(status["message"]))
    except (ImportFailure, OSError) as error:
        print(f"Import failed: {error}", file=sys.stderr)
        return 1
    print(f"Added: {entry['title']} -> {entry['url']}")
    if publish:
        try:
            result = publish_library()
        except (ImportFailure, OSError, subprocess.TimeoutExpired) as error:
            print(f"Publish failed: {error}", file=sys.stderr)
            return 1
        print(f"Published: {result['url']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
