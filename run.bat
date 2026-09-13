@echo off
rem 集成模式：后端 + 前端一起跑在 8080
rem 优先使用包内自带的 Node 运行时（node\node.exe），没有则用系统 node
cd /d %~dp0
if exist node\node.exe (
  node\node.exe backend\server.js
) else (
  node backend\server.js
)
