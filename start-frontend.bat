@echo off
rem 分离模式：先另开一个窗口跑 run.bat 启动后端(9000)，再运行本脚本启动前端(5500)
cd /d %~dp0
if exist node\node.exe (
  node\node.exe frontend\serve.js
) else (
  node frontend\serve.js
)
