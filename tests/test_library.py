import json
import os
from pathlib import Path
import tempfile
import threading
import time
import unittest
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen
from urllib.parse import quote

from tools import library
import manage_library


class LibraryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = library.load_engine()

    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        (self.root / "data").mkdir()
        self.initial = {"textbooks": [], "pastExams": [{"title": "Keep archive"}], "challengeExams": [{"title": "Keep challenge"}]}
        library.atomic_json(self.root / "data/catalog.json", self.initial)
        self.pdf = self.root / "source.pdf"
        with self.engine["extract_book_contents"].pymupdf.open() as document:
            page = document.new_page()
            page.insert_text((72, 72), "1 Linear Equations 1\n1.1 Solving equations 2\n2 Quadratics 4\n2.1 Factoring 5")
            document.save(self.pdf)
        self.options = {"id": "test-book", "title": "Test Math", "author": "Test author", "description": "Original test fixture", "subject": "math", "mode": "contents", "start_page": 1, "end_page": 1, "filename": "source.pdf"}
        self.environment = patch.dict(os.environ, {"OPENAI_API_KEY": "test-not-a-real-key", "OPENAI_BASE_URL": "https://example.invalid/v1"})
        self.environment.start()

    def tearDown(self):
        self.environment.stop()
        self.temporary.cleanup()

    def completion_response(self, *args, **kwargs):
        prompt = json.loads(kwargs["json"]["messages"][-1]["content"])
        payload = {"overview": "Generated introduction", "sections": [{"heading": heading, "paragraphs": ["Explanation.", "A new example."], "formulas": ["x + 2 = 5"], "steps": [], "key_points": ["Check your answer."]} for heading in prompt["subtopics"]]}
        response = MagicMock()
        response.json.return_value = {"choices": [{"message": {"content": json.dumps(payload)}}]}
        return response

    def import_book(self, **changes):
        return library.import_pdf(self.pdf, {**self.options, **changes}, root=self.root)

    def test_actual_classifi_pdf_pipeline_registers_readable_book_without_source_pdf(self):
        with patch.object(self.engine["tutor_graph"].requests, "post", side_effect=self.completion_response) as post:
            entry = self.import_book()
        self.assertEqual(post.call_count, 2)
        self.assertEqual(entry["url"], "#book/test-book")
        self.assertEqual(entry["chapter_count"], 2)
        catalog = library.read_catalog(self.root)
        self.assertEqual(catalog["pastExams"], self.initial["pastExams"])
        self.assertEqual(catalog["challengeExams"], self.initial["challengeExams"])
        book = json.loads((self.root / entry["book_path"][2:]).read_text(encoding="utf-8"))
        self.assertEqual(book["format"], "aceat.classifi-book.v1")
        self.assertEqual(book["chapters"][0]["sections"][0]["heading"], "1.1. Solving equations")
        self.assertEqual(book["engine"]["name"], "Classifi")
        self.assertFalse(list((self.root / "data").rglob("*.pdf")))
        self.assertNotIn("test-not-a-real-key", json.dumps(book))

    def test_failure_preserves_catalog_and_retry_reuses_completed_chapter(self):
        attempts = []
        def fail_second(*args, **kwargs):
            attempts.append(1)
            if len(attempts) == 2:
                raise self.engine["tutor_graph"].requests.RequestException("provider-sensitive-response")
            return self.completion_response(*args, **kwargs)
        with patch.object(self.engine["tutor_graph"].requests, "post", side_effect=fail_second):
            with self.assertRaises(library.ImportFailure) as caught:
                self.import_book()
        self.assertNotIn("provider-sensitive-response", str(caught.exception))
        self.assertEqual(library.read_catalog(self.root), self.initial)
        self.assertFalse((self.root / "data/books").exists())
        with patch.object(self.engine["tutor_graph"].requests, "post", side_effect=self.completion_response) as post:
            self.import_book()
        self.assertEqual(post.call_count, 1)

    def test_duplicate_is_rejected_and_explicit_replace_keeps_one_entry(self):
        with patch.object(self.engine["tutor_graph"].requests, "post", side_effect=self.completion_response):
            self.import_book()
            with self.assertRaisesRegex(library.ImportFailure, "ID"):
                self.import_book()
            self.import_book(replace=True, title="Updated title")
        catalog = library.read_catalog(self.root)
        self.assertEqual(len(catalog["textbooks"]), 1)
        self.assertEqual(catalog["textbooks"][0]["title"], "Updated title")

    def test_bad_ranges_and_ids_are_rejected_without_ai_requests(self):
        with patch.object(self.engine["tutor_graph"].requests, "post") as post:
            for changes in ({"id": "../escape"}, {"start_page": 0}, {"end_page": 5}, {"mode": "pages", "subject": "reading"}):
                with self.subTest(changes=changes), self.assertRaises(library.ImportFailure):
                    self.import_book(**changes)
        post.assert_not_called()

    def test_math_page_mode_uses_classifi_source_extraction(self):
        response = MagicMock()
        payload = {"sections": [{"heading": "Solving equations", "paragraphs": ["A new explanation."], "formulas": ["x = 3"], "steps": ["Check the result."], "key_points": []}]}
        response.json.return_value = {"choices": [{"message": {"content": json.dumps(payload)}}]}
        with patch.object(self.engine["tutor_graph"].requests, "post", return_value=response) as post:
            entry = self.import_book(mode="pages")
        book = json.loads((self.root / entry["book_path"][2:]).read_text(encoding="utf-8"))
        self.assertEqual(book["generation_mode"], "pages")
        self.assertEqual(len(book["chapters"]), 1)
        self.assertIn("Linear Equations", post.call_args.kwargs["json"]["messages"][-1]["content"])

    def test_catalog_write_failure_does_not_replace_existing_catalog(self):
        write = library.atomic_json
        def fail_catalog(path, data):
            if path.name == "catalog.json":
                raise OSError("disk failure")
            write(path, data)
        with patch.object(self.engine["tutor_graph"].requests, "post", side_effect=self.completion_response), patch.object(library, "atomic_json", side_effect=fail_catalog):
            with self.assertRaises(OSError):
                self.import_book()
        self.assertEqual(library.read_catalog(self.root), self.initial)
        self.assertFalse(list((self.root / "data/books").glob("*.json")))

    def test_non_numbered_contents_failure_is_clear_and_does_not_publish(self):
        with self.engine["extract_book_contents"].pymupdf.open() as document:
            document.new_page().insert_text((72, 72), "This is ordinary text without numbered contents.")
            document.save(self.root / "no-contents.pdf")
        with self.assertRaises(library.ImportFailure):
            library.import_pdf(self.root / "no-contents.pdf", self.options, root=self.root)
        self.assertEqual(library.read_catalog(self.root), self.initial)

    def test_http_import_completes_and_private_paths_are_not_served(self):
        server = manage_library.LibraryServer(0, root=self.root)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        base = f"http://127.0.0.1:{server.server_port}"
        headers = {"Origin": base, "X-ACEat-Token": server.token, "X-ACEat-Metadata": quote(json.dumps(self.options)), "Content-Type": "application/pdf"}
        try:
            with patch.object(self.engine["tutor_graph"].requests, "post", side_effect=self.completion_response):
                request = Request(base + "/api/imports", data=self.pdf.read_bytes(), headers=headers)
                with urlopen(request, timeout=5) as response:
                    self.assertEqual(response.status, 202)
                deadline = time.monotonic() + 10
                while server.job["status"] in ("queued", "running") and time.monotonic() < deadline:
                    time.sleep(.02)
            self.assertEqual(server.job["status"], "completed", server.job)
            for path in ("/.env", "/.local/uploads/source.pdf", "/source.pdf", "/manage_library.py"):
                with self.assertRaises(HTTPError) as error:
                    urlopen(base + path, timeout=5)
                self.assertEqual(error.exception.code, 404)
                error.exception.close()
            with self.assertRaises(HTTPError) as error:
                urlopen(Request(base + "/api/imports", data=b"%PDF-test", headers={**headers, "Origin": "https://untrusted.invalid"}), timeout=5)
            self.assertEqual(error.exception.code, 403)
            error.exception.close()
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()

    def test_publish_rejects_unrelated_staged_changes_before_git_add(self):
        def git_result(args, **kwargs):
            command = args[3:]
            output = "main\n" if command[:1] == ["branch"] else "https://github.com/The-Fabulous/ACEat.git\n" if command[:2] == ["remote", "get-url"] else "app.js\n"
            return MagicMock(stdout=output, returncode=0)
        with patch.object(library.subprocess, "run", side_effect=git_result) as run:
            with self.assertRaisesRegex(library.ImportFailure, "подготовленные"):
                library.publish_library(self.root)
        self.assertFalse(any("add" in call.args[0][3:] for call in run.call_args_list))

    def test_editorial_lock_blocks_overlap_and_releases_after_exception(self):
        with self.assertRaisesRegex(RuntimeError, "test failure"):
            with library.editorial_lock(self.root):
                with self.assertRaises(library.ImportFailure):
                    with library.editorial_lock(self.root):
                        pass
                raise RuntimeError("test failure")
        with library.editorial_lock(self.root):
            pass

    def test_publication_stages_only_catalog_and_referenced_generated_json(self):
        with patch.object(self.engine["tutor_graph"].requests, "post", side_effect=self.completion_response):
            entry = self.import_book()
        def git_result(args, **kwargs):
            command = args[3:]
            output = "main\n" if command[:1] == ["branch"] else "https://github.com/The-Fabulous/ACEat.git\n" if command[:2] == ["remote", "get-url"] else "abc123\n" if command[:1] == ["rev-parse"] else ""
            return MagicMock(stdout=output, returncode=1 if command == ["diff", "--cached", "--quiet"] else 0)
        with patch.object(library.subprocess, "run", side_effect=git_result) as run:
            result = library.publish_library(self.root)
        commands = [call.args[0][3:] for call in run.call_args_list]
        self.assertIn(["add", "--", "data/catalog.json", entry["book_path"][2:]], commands)
        self.assertIn(["push", "origin", "main"], commands)
        self.assertEqual(result["commit"], "abc123")


if __name__ == "__main__":
    unittest.main()
