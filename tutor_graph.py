import json
import re
from typing import Literal, TypedDict

from langgraph.graph import END, START, StateGraph
from textbook_engine.client import LLMRequestError, request_completion


MAX_HISTORY_MESSAGES = 8
TOPICS = {
    "algebra": "SAT Algebra: linear equations, inequalities, systems and linear functions",
    "advanced": "SAT Advanced Math: nonlinear equations, polynomials, exponentials and equivalent expressions",
    "data": "SAT Problem-Solving and Data Analysis: ratios, percentages, probability, statistics and data interpretation",
    "geometry": "SAT Geometry and Trigonometry: areas, volumes, angles, triangles, circles and right-triangle trigonometry",
    "reading": "SAT Reading and Writing: information and ideas, craft and structure, expression of ideas and Standard English conventions",
}

INTENT_SYSTEM_PROMPT = """Определи тип учебного запроса при подготовке к Digital SAT.
Верни ровно одно слово: formula, если пользователь просит правило/формулу или объяснение теории;
solve, если просит решить, вычислить, разобрать текст, проверить ответ или показать конкретный пример.
При сомнении используй solve."""
CHAT_SYSTEM_PROMPT = r"""Вы — терпеливый преподаватель Digital SAT Math и Reading & Writing.
Объясняйте по-русски, если ученик не попросит другой язык. Примеры Reading & Writing давайте на английском.
Учитывайте выбранную тему и предыдущие сообщения ученика. На вопросы вне SAT предложите вернуться к подготовке.
Для Reading & Writing объясняйте правила, аргументацию и выбор ответа; формулы не обязательны.
Если ученик просит пример, составьте новый пример по выбранной теме и разберите его.
Не выдавайте придуманные задания за настоящие экзаменационные материалы.
Решайте точно и не пропускайте преобразования. В шагах сначала назовите правило, затем покажите его применение.
Формулы записывайте в LaTeX, пригодном для MathJax; поле formula каждого шага должно содержать только LaTeX без разделителей $.
Не используйте Markdown, HTML или блочные окружения в JSON-строках.
Если в условии не хватает данных, не выдумывайте их: сформулируйте один короткий уточняющий вопрос в summary, steps оставьте пустым.
Верните только валидный JSON такой формы:
{"intent":"formula|solve","summary":"краткий план или уточняющий вопрос","steps":[{"explanation":"название правила и пояснение","formula":"f'(x)=..."}],"answer":"итоговый ответ обычным текстом с LaTeX внутри \\(...\\), если он нужен"}
Для запроса формулы intent=formula; кратко объясните смысл и условия её применения.
Для решения примера intent=solve; перечислите шаги в порядке решения и явно выделите ответ.
"""


class ChatStep(TypedDict):
    explanation: str
    formula: str


class ChatAnswer(TypedDict):
    intent: Literal["formula", "solve"]
    summary: str
    steps: list[ChatStep]
    answer: str


class ChatState(TypedDict, total=False):
    message: str
    topic: str
    history: list[dict[str, str]]
    intent: Literal["formula", "solve"]
    answer: ChatAnswer


def parse_chat_answer(content: str) -> ChatAnswer:
    cleaned = content.strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE)
    try:
        raw = json.loads(cleaned)
    except json.JSONDecodeError:
        start = cleaned.find("{")
        end = cleaned.rfind("}")
        if start < 0 or end <= start:
            raise LLMRequestError("The AI response was not valid JSON. Please try again.")
        try:
            raw = json.loads(cleaned[start:end + 1])
        except json.JSONDecodeError as error:
            raise LLMRequestError(
                "The AI response was not valid JSON. Please try again."
            ) from error

    if not isinstance(raw, dict):
        raise LLMRequestError("The AI response has an invalid format. Please try again.")
    intent = raw.get("intent")
    summary = raw.get("summary")
    steps = raw.get("steps")
    answer = raw.get("answer")
    if (
        intent not in ("formula", "solve")
        or not isinstance(summary, str)
        or not isinstance(steps, list)
        or not isinstance(answer, str)
        or len(steps) > 16
        or any(
            not isinstance(step, dict)
            or not isinstance(step.get("explanation"), str)
            or not isinstance(step.get("formula"), str)
            for step in steps
        )
    ):
        raise LLMRequestError("The AI response has an invalid format. Please try again.")
    return {
        "intent": intent,
        "summary": summary[:4_000],
        "steps": [
            {
                "explanation": step["explanation"][:2_000],
                "formula": step["formula"][:2_000],
            }
            for step in steps
        ],
        "answer": answer[:4_000],
    }


def classify_chat_intent(state: ChatState) -> dict[str, str]:
    intent = request_completion(
        [
            {"role": "system", "content": INTENT_SYSTEM_PROMPT},
            *state.get("history", [])[-MAX_HISTORY_MESSAGES:],
            {"role": "user", "content": state["message"]},
        ]
    ).strip().lower().strip(".")
    if intent not in ("formula", "solve"):
        raise LLMRequestError("The AI could not classify this request. Please rephrase it.")
    return {"intent": intent}


def route_chat_intent(state: ChatState) -> Literal["formula", "solve"]:
    return state["intent"]


def generate_chat_answer(state: ChatState) -> dict[str, ChatAnswer]:
    selected_intent = state["intent"]
    intent_label = "формулу или объяснение правила" if selected_intent == "formula" else "пошаговое решение примера"
    messages = [
        {
            "role": "system",
            "content": (
                f"{CHAT_SYSTEM_PROMPT}\nВыбранная тема: {TOPICS[state['topic']]}.\n"
                f"Запрос классифицирован как {intent_label}; сохрани intent=\"{selected_intent}\"."
            ),
        },
        *state.get("history", [])[-MAX_HISTORY_MESSAGES:],
        {"role": "user", "content": state["message"]},
    ]
    answer = parse_chat_answer(request_completion(messages))
    answer["intent"] = selected_intent
    return {"answer": answer}


def build_chat_graph():
    graph = StateGraph(ChatState)
    graph.add_node("classify_request", classify_chat_intent)
    graph.add_node("explain_formula", generate_chat_answer)
    graph.add_node("solve_example", generate_chat_answer)
    graph.add_edge(START, "classify_request")
    graph.add_conditional_edges(
        "classify_request",
        route_chat_intent,
        {
            "formula": "explain_formula",
            "solve": "solve_example",
        },
    )
    graph.add_edge("explain_formula", END)
    graph.add_edge("solve_example", END)
    return graph.compile()


CHAT_GRAPH = build_chat_graph()
