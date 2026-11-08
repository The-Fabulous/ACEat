@echo off
setlocal
cd /d "%~dp0"
if exist "%~dp0..\Classifi\.venv\Scripts\python.exe" (
  "%~dp0..\Classifi\.venv\Scripts\python.exe" manage_library.py
) else (
  py -3 manage_library.py
)
if errorlevel 1 pause
