@echo off
rem 检查并更新到 GitHub 最新 Release（存档在 PostgreSQL，不受影响）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\update.ps1"
pause
