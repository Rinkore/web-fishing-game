@echo off
rem 集成模式：Go 后端 + 前端一起跑在 9000（连接串写在 config.env）
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0tools\start-go.ps1"
if errorlevel 1 pause
