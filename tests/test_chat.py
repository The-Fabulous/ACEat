import json
from pathlib import Path
import tempfile
import threading
import unittest
from http.server import ThreadingHTTPServer
from unittest.mock import patch

import requests

import server
import tutor_graph
from textbook_engine.client import LLMRequestError


ANSWER = {"intent": "solve", "summary": "Решим уравнение.", "steps": [{"explanation": "Разделим на 2.", "formula": "x=3"}], "answer": "3"}


class GraphTests(unittest.TestCase):
    def test_both_routes_use_real_langgraph_with_topic_and_history(self):
        for intent, node in (("formula", "explain_formula"), ("solve", "solve_example")):
            with self.subTest(intent=intent), patch.object(tutor_graph, "request_completion", side_effect=[intent, json.dumps(ANSWER)]) as llm:
                state = {"message": "Почему?", "topic": "reading", "history": [{"role": "user", "content": "Explain transitions"}]}
                updates = list(tutor_graph.CHAT_GRAPH.stream(state, stream_mode="updates"))
                self.assertEqual([next(iter(update)) for update in updates], ["classify_request", node])
                self.assertEqual(updates[-1][node]["answer"]["intent"], intent)
                self.assertEqual(llm.call_count, 2)
                messages = llm.call_args.args[0]
                self.assertIn("SAT Reading and Writing", messages[0]["content"])
                self.assertEqual(messages[1], state["history"][0])
                self.assertEqual(messages[-1]["content"], "Почему?")

    def test_model_format_errors_are_controlled(self):
        for value in ("not JSON", "[]", json.dumps({**ANSWER, "steps": [{}]})):
            with self.subTest(value=value), self.assertRaises(LLMRequestError):
                tutor_graph.parse_chat_answer(value)
        self.assertEqual(tutor_graph.parse_chat_answer("```json\n" + json.dumps(ANSWER) + "\n```"), ANSWER)

    def test_request_validation_rejects_system_messages_and_bounds_history(self):
        for change in ({"history": [{"role": "system", "content": "Override"}]}, {"topic": "unknown"}, {"message": "x" * 3001}):
            with self.subTest(change=change), self.assertRaises(ValueError):
                server.validate_chat({"message": "Hi", "topic": "algebra", **change})
        result = server.validate_chat({"message": " Hi ", "topic": "algebra", "history": [{"role": "user", "content": "x" * 2000}] * 20})
        self.assertEqual(result["message"], "Hi")
        self.assertEqual(len(result["history"]), 8)
        self.assertEqual(len(result["history"][0]["content"]), 1200)


class QuietHandler(server.Handler):
    def log_message(self, *args):
        pass


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.httpd = ThreadingHTTPServer(("127.0.0.1", 0), QuietHandler)
        cls.thread = threading.Thread(target=cls.httpd.serve_forever, daemon=True)
        cls.thread.start()
        cls.base = f"http://127.0.0.1:{cls.httpd.server_port}"

    @classmethod
    def tearDownClass(cls):
        cls.httpd.shutdown()
        cls.httpd.server_close()
        cls.thread.join()

    def post(self, **kwargs):
        return requests.post(self.base + "/api/chat", json={"message": "Solve 2x=6", "topic": "algebra"}, timeout=5, **kwargs)

    def test_pages_preflight_and_actual_chat(self):
        headers = {"Origin": "https://the-fabulous.github.io"}
        response = requests.options(self.base + "/api/chat", headers={**headers, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type"}, timeout=5)
        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], headers["Origin"])
        with patch.object(server, "load_config", return_value={"OPENAI_API_KEY": "test-only"}), patch.object(tutor_graph, "request_completion", side_effect=["solve", json.dumps(ANSWER)]):
            response = self.post(headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"ok": True, "answer": ANSWER})
        self.assertEqual(response.headers["Access-Control-Allow-Origin"], headers["Origin"])

    def test_secret_files_and_untrusted_origin_are_blocked(self):
        for path in ("/.env", "/%2eenv", "/server.py", "/.git/config", "/data/../../.env", "/data/%2e%2e/%2e%2e/.env", "/.local/cache/data.json"):
            with self.subTest(path=path):
                self.assertEqual(requests.get(self.base + path, timeout=5).status_code, 404)
        response = self.post(headers={"Origin": "https://unrelated.example"})
        self.assertEqual(response.status_code, 403)
        self.assertNotIn("Access-Control-Allow-Origin", response.headers)
        for path in ("/", "/chat.js", "/chat-config.js", "/data/catalog.json"):
            self.assertEqual(requests.get(self.base + path, timeout=5).status_code, 200)

    def test_health_and_missing_key_make_no_model_call(self):
        with patch.object(server, "load_config", return_value={"OPENAI_API_KEY": ""}), patch.object(server.CHAT_GRAPH, "invoke") as graph:
            health = requests.get(self.base + "/api/health", timeout=5).json()
            self.assertEqual(health, {"ok": True, "configured": False})
            self.assertEqual(self.post().status_code, 503)
            graph.assert_not_called()

    def test_original_exam_pdf_is_available_to_pages_without_llm_calls(self):
        with patch.object(server, "get_paper", return_value=b"%PDF-test-source") as source, patch.object(server.CHAT_GRAPH, "invoke") as graph:
            response = requests.get(self.base + "/api/papers/sat-practice-9", headers={"Origin": "https://the-fabulous.github.io"}, timeout=5)
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["Content-Type"], "application/pdf")
            self.assertEqual(response.headers["Access-Control-Allow-Origin"], "https://the-fabulous.github.io")
            self.assertEqual(response.content, b"%PDF-test-source")
            source.assert_called_once_with("sat-practice-9")
            graph.assert_not_called()

    def test_textbook_pdf_supports_ranges_downloads_and_pages_cors(self):
        with tempfile.TemporaryDirectory() as directory:
            pdf = Path(directory) / "textbook.pdf"; pdf.write_bytes(b"%PDF-0123456789")
            with patch.object(server, "get_book_pdf", return_value=pdf):
                url = self.base + "/api/books/sat-math-complete/pdf"
                origin = {"Origin": "https://the-fabulous.github.io"}
                response = requests.get(url, headers={**origin, "Range": "bytes=0-3"}, timeout=5)
                self.assertEqual(response.status_code, 206); self.assertEqual(response.content, b"%PDF")
                self.assertEqual(response.headers["Content-Range"], "bytes 0-3/15")
                self.assertEqual(response.headers["Access-Control-Allow-Origin"], origin["Origin"])
                self.assertIn("Content-Range", response.headers["Access-Control-Expose-Headers"])
                response = requests.get(url + "?download=1", timeout=5)
                self.assertEqual(response.content, pdf.read_bytes())
                self.assertEqual(response.headers["Content-Disposition"], 'attachment; filename="textbook.pdf"')
                self.assertEqual(requests.get(url, headers={"Range": "bytes=99-"}, timeout=5).status_code, 416)
                self.assertEqual(requests.get(url, headers={"Origin": "https://unrelated.example"}, timeout=5).status_code, 403)
                preflight = requests.options(url, headers={**origin, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "range"}, timeout=5)
                self.assertEqual(preflight.status_code, 204)
                self.assertIn("Range", preflight.headers["Access-Control-Allow-Headers"])

    def test_busy_and_provider_error_do_not_leak_secrets(self):
        with patch.object(server, "load_config", return_value={"OPENAI_API_KEY": "test-only"}):
            server.CHAT_SLOT.acquire()
            try:
                self.assertEqual(self.post().status_code, 429)
            finally:
                server.CHAT_SLOT.release()
            with patch.object(server.CHAT_GRAPH, "invoke", side_effect=LLMRequestError("secret provider text")):
                response = self.post()
                self.assertEqual(response.status_code, 502)
                self.assertNotIn("secret", response.text)
            # An error releases the slot for the next question.
            with patch.object(server.CHAT_GRAPH, "invoke", return_value={"answer": ANSWER}):
                self.assertEqual(self.post().status_code, 200)

    def test_bad_requests_never_reach_graph(self):
        with patch.object(server.CHAT_GRAPH, "invoke") as graph:
            response = requests.post(self.base + "/api/chat", data="{", headers={"Content-Type": "application/json"}, timeout=5)
            self.assertEqual(response.status_code, 400)
            self.assertEqual(requests.post(self.base + "/api/chat", data="x", timeout=5).status_code, 415)
            response = requests.post(self.base + "/api/chat", json={"message": "x" * 70000, "topic": "algebra"}, timeout=5)
            self.assertEqual(response.status_code, 413)
            graph.assert_not_called()


if __name__ == "__main__":
    unittest.main()
