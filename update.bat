@echo off
rem 检查并更新到 GitHub 最新 Release（存档在文档目录，不受影响）
node "%~dp0tools\update.js"
pause
