@echo off
cd /d "%~dp0"
start "Tim AI Local Server" /min node "%~dp0server.js"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4173/"
