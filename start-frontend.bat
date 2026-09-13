@echo off
rem 分离模式：先另开一个窗口跑 run.bat 启动后端(8080)，再运行本脚本启动前端(5500)
node frontend\serve.js
