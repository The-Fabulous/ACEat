# Local textbook engine

The book-processing logic was copied once from The-Fabulous/Classifi at commit
`93d232d`. This is an
independent source snapshot maintained inside ACEat, not an API client or loader.

Original functions:

- `contents.py`: PDF contents extraction and numbered chapter/subtopic parsing
  from `extract_book_contents.py`.
- `pages.py`: topic-based page generation, validation, and retry from
  `generate_topic_pages.py`.
- `excerpts.py`: math excerpt extraction, section validation, and merging from
  `import_book.py`.
- `client.py`: model configuration and completion request from `tutor_graph.py`.
  It reads only ACEat's `.env` and process environment. Provider error bodies are
  omitted. Chat/graph code and LangGraph are not included.

Relative imports refer exclusively to this package. No runtime Git access,
repository download, `sys.path` modification, or reading from a Classifi folder
is performed. The model API is called only when the author runs the driver and
uncached chapters need generation. Visitors read prepared JSON in the textbook
collection.

Source repository: https://github.com/The-Fabulous/Classifi
