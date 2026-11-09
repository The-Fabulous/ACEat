"""Extract factual answer keys, page locations and score ranges for SAT 9/10.

Original questions stay on College Board's website and are embedded by the UI.
Uses requirements-import.txt. No LLM calls; PDF sources remain in .local/.
"""
import hashlib
import json
from pathlib import Path
import re

import pymupdf
import requests

ROOT = Path(__file__).resolve().parents[1]
CACHE = ROOT / ".local" / "exam-sources"
OUTPUT = ROOT / "data" / "exams"
BASE = "https://satsuite.collegeboard.org/media/pdf/"
BOUNDS = {9: (3, 17, 31, 39, 56), 10: (3, 17, 31, 43, 56)}


def source(name):
    path = CACHE / name
    if not path.exists():
        response = requests.get(BASE + name, timeout=40)
        response.raise_for_status()
        if not response.content.startswith(b"%PDF"):
            raise ValueError("Source is not a PDF")
        path.write_bytes(response.content)
    return path


def answer_columns(page):
    keys = []
    for left, right, count in ((58, 137, 33), (146, 225, 33), (252, 368, 27), (375, 490, 27)):
        text = page.get_text(clip=pymupdf.Rect(left, 235, right, 705), sort=True)
        rows = []
        for line in text.splitlines():
            match = re.fullmatch(r"\s*(\d+)\s+(.+?)\s*", line)
            if match:
                rows.append((int(match[1]), [item.strip() for item in match[2].split(";")]))
        if [row[0] for row in rows] != list(range(1, count + 1)):
            raise ValueError(f"Answer column did not contain {count} consecutive questions: {rows}")
        keys.append([row[1] for row in rows])
    return keys


def score_ranges(page):
    values = {"reading": {}, "math": {}}
    for left, right in ((30, 304), (307, 580)):
        text = page.get_text(clip=pymupdf.Rect(left, 330, right, 751), sort=True)
        for line in text.splitlines():
            row = line.split()
            if len(row) not in (3, 5) or not all(item.isdigit() for item in row):
                continue
            raw, low, high, *math = map(int, row)
            if not 0 <= raw <= 66 or not 200 <= low <= high <= 800:
                continue
            values["reading"][raw] = [low, high]
            if math:
                values["math"][raw] = math
    result = {}
    for section, maximum in (("reading", 66), ("math", 54)):
        if sorted(values[section]) != list(range(maximum + 1)):
            raise ValueError(f"Incomplete {section} score conversion table")
        result[section] = [values[section][raw] for raw in range(maximum + 1)]
        if result[section][0] != [200, 200] or result[section][-1] != [800, 800]:
            raise ValueError("Unexpected score range endpoints")
    return result


def question_pages(doc, start, end, count):
    pages = {}
    for index in range(start, end):
        for block in doc[index].get_text("dict")["blocks"]:
            for line in block.get("lines", []):
                for span in line["spans"]:
                    number = span["text"].strip()
                    if span["color"] == 0xFFFFFF and "Minion" in span["font"] and number.isdigit():
                        number = int(number)
                        if number in pages:
                            raise ValueError("Duplicate question heading")
                        pages[number] = index + 1
    if sorted(pages) != list(range(1, count + 1)):
        raise ValueError(f"Missing question pages: {sorted(pages)}")
    return pages


def prepare(number):
    paper_name = f"sat-practice-test-{number}-digital.pdf"
    scoring_name = f"scoring-sat-practice-test-{number}-digital.pdf"
    paper_path, scoring_path = source(paper_name), source(scoring_name)
    with pymupdf.open(paper_path) as paper, pymupdf.open(scoring_path) as scoring:
        if len(paper) != 56 or len(scoring) != 5:
            raise ValueError("Unexpected source edition; review the PDFs before importing")
        keys = answer_columns(scoring[3])
        modules = []
        for index, answers in enumerate(keys):
            section = "reading" if index < 2 else "math"
            title = "Reading & Writing" if index < 2 else "Math"
            pages = question_pages(paper, BOUNDS[number][index], BOUNDS[number][index + 1], len(answers))
            modules.append({
                "id": f"{section}-{index % 2 + 1}", "section": section,
                "title": f"{title} · Модуль {index % 2 + 1}",
                "questions": [
                    {"number": q, "page": pages[q], "type": "choice" if len(key) == 1 and key[0] in "ABCD" else "number", "answers": key}
                    for q, key in enumerate(answers, 1)
                ],
            })
        data = {
            "format": "aceat.paper-exam.v1", "revision": 1,
            "id": f"sat-practice-{number}", "title": f"SAT Practice Test {number}",
            "paper_url": BASE + paper_name, "scoring_url": BASE + scoring_name,
            "explanations_url": BASE + f"sat-practice-test-{number}-answers-digital.pdf",
            "source": "College Board · official nonadaptive paper practice test",
            "source_sha256": {"paper": hashlib.sha256(paper_path.read_bytes()).hexdigest(), "scoring": hashlib.sha256(scoring_path.read_bytes()).hexdigest()},
            "page_count": len(paper), "modules": modules, "scoring": score_ranges(scoring[4]),
        }
    path = OUTPUT / f"sat-practice-{number}.json"
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Prepared {data['id']}: {sum(len(m['questions']) for m in modules)} questions")


if __name__ == "__main__":
    CACHE.mkdir(parents=True, exist_ok=True)
    OUTPUT.mkdir(parents=True, exist_ok=True)
    for number in (9, 10):
        prepare(number)
