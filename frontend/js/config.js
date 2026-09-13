/*
 * 前后端分离配置（无需构建，刷新页面即生效）
 * API_BASE 取值：
 *   - 'auto'（默认）：页面由后端(8080)托管时走同源；否则自动指向同主机的 8080 端口
 *   - ''            ：强制同源（前端与后端反向代理到同一域名下时用）
 *   - 显式字符串    ：直接使用，例如 'http://localhost:8080' 或 'https://api.example.com'
 */
window.APP_CONFIG = { API_BASE: 'auto' };
