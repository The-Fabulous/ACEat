import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import MagicMock, patch

import exam_source


class PaperSourceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.pdf = b"%PDF-1.7\nTest source data\n"
        manifests = self.root / "data" / "exams"
        manifests.mkdir(parents=True)
        (manifests / "sat-practice-9.json").write_text(json.dumps({"source_sha256": {"paper": hashlib.sha256(self.pdf).hexdigest()}}), encoding="utf-8")
        self.root_patch = patch.object(exam_source, "ROOT", self.root)
        self.cache_patch = patch.object(exam_source, "CACHE", self.root / "cache")
        self.root_patch.start(); self.cache_patch.start()

    def tearDown(self):
        self.root_patch.stop(); self.cache_patch.stop(); self.directory.cleanup()

    def response(self, data):
        response = MagicMock()
        response.__enter__.return_value = response
        response.iter_content.return_value = [data]
        return response

    def test_download_uses_fixed_official_url_then_reuses_verified_cache(self):
        with patch.object(exam_source.requests, "get", return_value=self.response(self.pdf)) as download:
            self.assertEqual(exam_source.get_paper("sat-practice-9"), self.pdf)
            self.assertEqual(exam_source.get_paper("sat-practice-9"), self.pdf)
            download.assert_called_once_with("https://satsuite.collegeboard.org/media/pdf/sat-practice-test-9-digital.pdf", timeout=40, stream=True)

    def test_changed_edition_and_oversized_download_are_not_published(self):
        with patch.object(exam_source.requests, "get", return_value=self.response(b"%PDF-different edition")):
            with self.assertRaises(exam_source.PaperSourceError):
                exam_source.get_paper("sat-practice-9")
        with patch.object(exam_source, "MAX_PDF_BYTES", 4), patch.object(exam_source.requests, "get", return_value=self.response(self.pdf)):
            with self.assertRaises(exam_source.PaperSourceError):
                exam_source.get_paper("sat-practice-9")
        self.assertFalse((exam_source.CACHE / "sat-practice-test-9-digital.pdf").exists())

    def test_unknown_ids_never_access_network_or_local_paths(self):
        with patch.object(exam_source.requests, "get") as download:
            for value in ("../../.env", "https://example.com/", "sat-practice-99"):
                with self.assertRaises(KeyError):
                    exam_source.get_paper(value)
            download.assert_not_called()


if __name__ == "__main__":
    unittest.main()
