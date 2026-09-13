/*
 * 前后端分离配置（无需构建，刷新页面即生效）
 * API_BASE 取值：
 *   - 'auto'（默认）：集成模式（后端托管前端，任意端口）走同源；否则自动指向同主机的 9000 端口
 *   - ''            ：强制同源（前端与后端反向代理到同一域名下时用）
 *   - 显式字符串    ：直接使用，例如 'http://localhost:9000' 或 'https://api.example.com'
 */
window.APP_CONFIG = { API_BASE: 'auto' };
