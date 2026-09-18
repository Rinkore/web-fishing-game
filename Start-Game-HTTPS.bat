@echo off
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-https.ps1"
set "GAME_EXIT=%ERRORLEVEL%"
pause
exit /b %GAME_EXIT%
