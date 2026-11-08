"""Copied from Classifi 93d232d; maintained locally in ACEat. See ORIGIN.md."""
import re
from pathlib import Path
from typing import Any
import pymupdf


CHAPTER_NUMBER_PATTERN = re.compile(r"^\d{1,2}$")


SUBTOPIC_NUMBER_PATTERN = re.compile(r"^\d{1,2}\.\d{1,2}\.?$")


APPENDIX_SUBTOPIC_PATTERN = re.compile(r"^[A-Z]\.\d{1,2}\.?$")


INLINE_CHAPTER_PATTERN = re.compile(r"^(\d{1,2})\s+(.+)$")


ROMAN_CHAPTER_PATTERN = re.compile(r"^([IVXLCDM]{1,6})\s+(.+)$")


INLINE_SUBTOPIC_PATTERN = re.compile(r"^(\d{1,2}\.\d{1,2}\.?|[A-Z]\.\d{1,2}\.?)\s+(.+)$")


PAGE_NUMBER_SUFFIX_PATTERN = re.compile(r"\s+(?:\d+|[ivxlcdm]+)$", re.IGNORECASE)


TOC_LEADER_SUFFIX_PATTERN = re.compile(r"\s*(?:\.{2,}|…+)\s*$")


def clean_contents_title(value: str) -> str:
    without_page_number = PAGE_NUMBER_SUFFIX_PATTERN.sub("", value).strip()
    return TOC_LEADER_SUFFIX_PATTERN.sub("", without_page_number).strip()


def parse_contents_pages(page_texts: list[str]) -> dict[str, list[dict[str, Any]]]:
    topics: list[dict[str, Any]] = []
    current_topic: dict[str, Any] | None = None

    lines = [line.strip() for text in page_texts for line in text.splitlines()]
    index = 0
    while index < len(lines):
        line = lines[index]
        inline_chapter = INLINE_CHAPTER_PATTERN.fullmatch(line)
        roman_chapter = ROMAN_CHAPTER_PATTERN.fullmatch(line)
        inline_subtopic = INLINE_SUBTOPIC_PATTERN.fullmatch(line)
        if inline_chapter:
            title = clean_contents_title(inline_chapter.group(2))
            current_topic = {
                "topic": f"{inline_chapter.group(1)}. {title}",
                "subtopics": [],
            }
            topics.append(current_topic)
        elif roman_chapter:
            title = clean_contents_title(roman_chapter.group(2))
            current_topic = {
                "topic": f"{roman_chapter.group(1)}. {title}",
                "subtopics": [],
            }
            topics.append(current_topic)
        elif inline_subtopic and current_topic is not None:
            title = clean_contents_title(inline_subtopic.group(2))
            number = inline_subtopic.group(1).rstrip(".")
            current_topic["subtopics"].append(f"{number}. {title}")
        elif CHAPTER_NUMBER_PATTERN.fullmatch(line):
            title_index = index + 1
            while title_index < len(lines) and not lines[title_index]:
                title_index += 1
            if title_index < len(lines):
                title = clean_contents_title(lines[title_index])
                if title:
                    current_topic = {
                        "topic": f"{line}. {title}",
                        "subtopics": [],
                    }
                    topics.append(current_topic)
                    index = title_index
        elif (
            SUBTOPIC_NUMBER_PATTERN.fullmatch(line)
            or APPENDIX_SUBTOPIC_PATTERN.fullmatch(line)
        ) and current_topic is not None:
            title_index = index + 1
            while title_index < len(lines) and not lines[title_index]:
                title_index += 1
            if title_index < len(lines):
                title = clean_contents_title(lines[title_index])
                if title:
                    number = line.rstrip(".")
                    current_topic["subtopics"].append(f"{number}. {title}")
                    index = title_index
        index += 1

    if not topics:
        raise ValueError("No chapter entries found in the selected PDF pages.")
    return {"topics": topics}


def create_book_contents(
    pdf_path: Path, start_page: int, end_page: int
) -> dict[str, list[dict[str, Any]]]:
    if not pdf_path.is_file():
        raise FileNotFoundError(f"PDF not found: {pdf_path}")
    try:
        with pymupdf.open(pdf_path) as document:
            if end_page > document.page_count:
                raise ValueError(
                    f"end_page is {end_page}, but the PDF has only "
                    f"{document.page_count} pages."
                )
            page_texts = [
                document[page_number - 1].get_text()
                for page_number in range(start_page, end_page + 1)
            ]
            return parse_contents_pages(page_texts)
    except pymupdf.FileDataError as error:
        raise ValueError(f"Could not open PDF {pdf_path}: {error}") from error
