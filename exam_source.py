"""Verified local cache of the two public College Board source documents."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import threading

import requests

ROOT = Path(__file__).resolve().parent
CACHE = (Path(tempfile.gettempdir()) / "aceat" / "exam-sources") if os.environ.get("VERCEL") else ROOT / ".local" / "exam-sources"
PAPER_IDS = {"sat-practice-9", "sat-practice-10"}
MAX_PDF_BYTES = 16 * 1024 * 1024
PAPER_LOCK = threading.Lock()


class PaperSourceError(RuntimeError):
    pass


def get_paper(exam_id):
    if exam_id not in PAPER_IDS:
        raise KeyError(exam_id)
    try:
        manifest = json.loads((ROOT / "data" / "exams" / f"{exam_id}.json").read_text(encoding="utf-8"))
        expected_hash = manifest["source_sha256"]["paper"]
        name = f"sat-practice-test-{exam_id.rsplit('-', 1)[1]}-digital.pdf"
        # Never accept a visitor-supplied upstream URL or filesystem path.
        url = f"https://satsuite.collegeboard.org/media/pdf/{name}"
        with PAPER_LOCK:
            path = CACHE / name
            if path.exists() and path.stat().st_size <= MAX_PDF_BYTES:
                data = path.read_bytes()
                if hashlib.sha256(data).hexdigest() == expected_hash:
                    return data
            with requests.get(url, timeout=40, stream=True) as response:
                response.raise_for_status()
                chunks, size = [], 0
                for chunk in response.iter_content(64 * 1024):
                    size += len(chunk)
                    if size > MAX_PDF_BYTES:
                        raise PaperSourceError("Source PDF exceeds the size limit")
                    chunks.append(chunk)
            data = b"".join(chunks)
            if not data.startswith(b"%PDF") or hashlib.sha256(data).hexdigest() != expected_hash:
                raise PaperSourceError("Source edition no longer matches this answer key")
            CACHE.mkdir(parents=True, exist_ok=True)
            temporary = path.with_suffix(".tmp")
            temporary.write_bytes(data)
            temporary.replace(path)
            return data
    except (OSError, ValueError, requests.RequestException) as error:
        raise PaperSourceError("Could not load the official source PDF") from error
