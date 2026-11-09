import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import book_source


class BookSourceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.pdf = b"%PDF-test-textbook-source"
        (self.root / "data").mkdir()
        self.url = "https://official.example/book.pdf"
        (self.root / "data" / "textbook-sources.json").write_text(json.dumps({"sources": [{"id": "sat-math-complete", "url": self.url, "sha256": hashlib.sha256(self.pdf).hexdigest()}]}), encoding="utf-8")
        self.root_patch = patch.object(book_source, "ROOT", self.root)
        self.cache_patch = patch.object(book_source, "CACHE", self.root / "sources")
        self.root_patch.start(); self.cache_patch.start(); book_source.VERIFIED.clear()

    def tearDown(self):
        self.root_patch.stop(); self.cache_patch.stop(); book_source.VERIFIED.clear(); self.directory.cleanup()

    def response(self, content):
        response = MagicMock(); response.__enter__.return_value = response; response.iter_content.return_value = [content]
        return response

    def test_download_is_verified_and_cached_as_a_file(self):
        with patch.object(book_source.requests, "get", return_value=self.response(self.pdf)) as download:
            path = book_source.get_book_pdf("sat-math-complete")
            self.assertEqual(path.read_bytes(), self.pdf)
            self.assertEqual(book_source.get_book_pdf("sat-math-complete"), path)
            download.assert_called_once_with(self.url, timeout=60, stream=True)

    def test_hash_mismatch_and_oversized_download_leave_no_partial_file(self):
        for data, limit in ((b"%PDF-different-edition", 1000), (self.pdf, 4)):
            with self.subTest(limit=limit), patch.object(book_source, "MAX_BOOK_BYTES", limit), patch.object(book_source.requests, "get", return_value=self.response(data)):
                with self.assertRaises(book_source.BookSourceError):
                    book_source.get_book_pdf("sat-math-complete")
        self.assertEqual(list(book_source.CACHE.glob("*")), [])

    def test_unknown_ids_never_read_source_paths_or_make_network_requests(self):
        with patch.object(book_source.requests, "get") as download:
            for value in ("../../.env", "sat-reading-meltzer/pdf/.env", "https://example.com"):
                with self.assertRaises(KeyError):
                    book_source.get_book_pdf(value)
            download.assert_not_called()

    def test_byte_ranges_include_closed_open_and_suffix_ranges(self):
        self.assertEqual(book_source.byte_range(None, 100), (0, 99))
        self.assertEqual(book_source.byte_range("bytes=10-19", 100), (10, 19))
        self.assertEqual(book_source.byte_range("bytes=90-", 100), (90, 99))
        self.assertEqual(book_source.byte_range("bytes=-10", 100), (90, 99))
        self.assertEqual(book_source.byte_range("bytes=0-999", 100), (0, 99))
        for value in ("bytes=100-", "bytes=5-2", "bytes=0-1,5-9", "bytes=-0", "other=1-2", "bytes=-"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                book_source.byte_range(value, 100)
