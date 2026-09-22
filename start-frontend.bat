@echo off
rem 分离模式：Go 后端由 run.bat 提供 API；本脚本只启动前端静态服务器(5500)
cd /d %~dp0
if exist node\node.exe (
  node\node.exe frontend\serve.js
) else (
  node frontend\serve.js
)
