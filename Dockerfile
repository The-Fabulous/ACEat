FROM python:3.12-slim
WORKDIR /app
COPY requirements-chat.txt ./
RUN pip install --no-cache-dir -r requirements-chat.txt
COPY server.py tutor_graph.py exam_source.py book_source.py index.html app.js chat.js exam.js library.js style.css exam.css library.css chat-config.js ./
COPY textbook_engine/__init__.py textbook_engine/client.py ./textbook_engine/
COPY data ./data/
ENV PORT=8000
EXPOSE 8000
CMD ["python", "server.py"]
