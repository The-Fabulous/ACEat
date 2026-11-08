import json
import os
from pathlib import Path
import tempfile
import threading
import subprocess
import sys
import shutil
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import unittest
from unittest.mock import MagicMock, patch

from tools import library


class LibraryTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.engine = library.ENGINE

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

    def test_bundled_pdf_pipeline_registers_readable_book_without_source_pdf(self):
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
        self.assertEqual(book["engine"]["name"], "ACEat Book Engine")
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

    def test_engine_modules_are_bundled_inside_aceat(self):
        folder = library.ROOT / "textbook_engine"
        for module in library.ENGINE.values():
            self.assertEqual(Path(module.__file__).resolve().parent, folder)
        self.assertNotIn("--engine-dir", subprocess.run([sys.executable, str(library.ROOT / "book_driver.py"), "--help"], capture_output=True, text=True, timeout=10).stdout)

    def test_standalone_driver_creates_collection_page_without_classifi_checkout(self):
        target = self.root / "standalone" / "ACEat"
        target.mkdir(parents=True)
        for package in ("tools", "textbook_engine"):
            shutil.copytree(library.ROOT / package, target / package, ignore=shutil.ignore_patterns("__pycache__"))
        shutil.copy2(library.ROOT / "book_driver.py", target / "book_driver.py")
        shutil.copy2(self.pdf, target / "source.pdf")
        library.atomic_json(target / "data/catalog.json", self.initial)
        test_case = self
        class ModelStub(BaseHTTPRequestHandler):
            calls = 0
            def do_POST(self):
                payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                ModelStub.calls += 1
                response = test_case.completion_response(json=payload).json()
                content = json.dumps(response).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(content)))
                self.end_headers()
                self.wfile.write(content)
            def log_message(self, *args):
                pass
        server = ThreadingHTTPServer(("127.0.0.1", 0), ModelStub)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        environment = {**os.environ, "CLASSIFI_DIR": str(target / "does-not-exist"), "PYTHONPATH": "", "OPENAI_BASE_URL": f"http://127.0.0.1:{server.server_port}/v1", "PYTHONIOENCODING": "utf-8"}
        command = [sys.executable, "book_driver.py", "source.pdf", "--id", "standalone-book", "--title", "Standalone book", "--start-page", "1", "--end-page", "1"]
        try:
            result = subprocess.run(command, cwd=target, env=environment, capture_output=True, text=True, encoding="utf-8", timeout=20)
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(ModelStub.calls, 2)
        self.assertIn("#book/standalone-book", result.stdout)
        entry = library.read_catalog(target)["textbooks"][0]
        book = json.loads((target / entry["book_path"][2:]).read_text(encoding="utf-8"))
        self.assertEqual(len(book["chapters"]), 2)
        self.assertEqual(book["engine"]["name"], "ACEat Book Engine")
        self.assertFalse((target.parent / "Classifi").exists())

    def test_driver_publication_requires_explicit_flag(self):
        argv = ["book_driver.py", str(self.pdf), "--id", "test-book", "--title", "Test book", "--start-page", "1", "--end-page", "1"]
        entry = {"title": "Test book", "url": "#book/test-book"}
        with patch.object(library, "import_pdf", return_value=entry), patch.object(library, "publish_library", return_value={"url": "https://example.invalid/"}) as publish:
            with patch.object(sys, "argv", argv):
                self.assertEqual(library.main(), 0)
            publish.assert_not_called()
            with patch.object(sys, "argv", argv + ["--publish"]):
                self.assertEqual(library.main(), 0)
            publish.assert_called_once()


if __name__ == "__main__":
    unittest.main()
