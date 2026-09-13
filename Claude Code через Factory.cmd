@echo off
node "%~dp0claude_factory.mjs" %*
if errorlevel 1 pause
