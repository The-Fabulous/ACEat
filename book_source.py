"""Allowlisted, verified textbook originals with streaming-friendly file access."""
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import threading

import requests

ROOT = Path(__file__).resolve().parent
CACHE = (Path(tempfile.gettempdir()) / "aceat" / "sat-sources") if os.environ.get("VERCEL") else ROOT / ".local" / "sat-sources"
BOOK_FILES = {
    "sat-math-complete": "complete-sat-math.pdf",
    "sat-reading-meltzer": "meltzer-sat-reading.pdf",
    "sat-grammar-meltzer": "meltzer-sat-grammar.pdf",
}
MAX_BOOK_BYTES = 64 * 1024 * 1024
BOOK_LOCK = threading.Lock()
VERIFIED = {}


class BookSourceError(RuntimeError):
    pass


def digest(path):
    result = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(128 * 1024), b""):
            result.update(chunk)
    return result.hexdigest()


def get_book_pdf(book_id):
    if book_id not in BOOK_FILES:
        raise KeyError(book_id)
    try:
        sources = json.loads((ROOT / "data" / "textbook-sources.json").read_text(encoding="utf-8"))["sources"]
        source = next(item for item in sources if item["id"] == book_id)
        expected = source["sha256"]
        path = CACHE / BOOK_FILES[book_id]
        with BOOK_LOCK:
            if path.is_file():
                stat = path.stat()
                stamp = (stat.st_size, stat.st_mtime_ns, expected)
                if stat.st_size <= MAX_BOOK_BYTES and (VERIFIED.get(book_id) == stamp or digest(path) == expected):
                    VERIFIED[book_id] = stamp
                    return path
            CACHE.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".part")
            try:
                # URLs come only from the three repository-owned source records.
                with requests.get(source["url"], timeout=60, stream=True) as response, temporary.open("wb") as output:
                    response.raise_for_status()
                    size = 0
                    for chunk in response.iter_content(64 * 1024):
                        size += len(chunk)
                        if size > MAX_BOOK_BYTES:
                            raise BookSourceError("Textbook source exceeds the size limit")
                        output.write(chunk)
                if digest(temporary) != expected:
                    raise BookSourceError("The textbook edition does not match the saved source")
                temporary.replace(path)
            finally:
                temporary.unlink(missing_ok=True)
            stat = path.stat()
            VERIFIED[book_id] = (stat.st_size, stat.st_mtime_ns, expected)
            return path
    except (OSError, ValueError, StopIteration, requests.RequestException) as error:
        raise BookSourceError("Could not load the textbook original") from error


def byte_range(value, size):
    """Return inclusive bounds. None means the complete file; invalid => ValueError."""
    if value is None:
        return 0, size - 1
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", value)
    if not match or not any(match.groups()) or size <= 0:
        raise ValueError("Invalid byte range")
    left, right = match.groups()
    if not left:
        count = int(right)
        if count <= 0:
            raise ValueError("Invalid suffix range")
        return max(0, size - count), size - 1
    start = int(left)
    end = min(int(right), size - 1) if right else size - 1
    if start >= size or end < start:
        raise ValueError("Unsatisfiable byte range")
    return start, end
