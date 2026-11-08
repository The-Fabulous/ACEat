@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Create ACEat's Python environment and install requirements-import.txt first.
  exit /b 1
)
".venv\Scripts\python.exe" book_driver.py %*
