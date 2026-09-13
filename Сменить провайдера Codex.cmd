@echo off
chcp 65001 >nul
set PYTHONUTF8=1
python "%~dp0switch_codex_provider.py" %*
pause
