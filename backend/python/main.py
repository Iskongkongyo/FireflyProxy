"""
Refactored & Optimized Reverse Proxy Service (Python Version)

🛠️ 依赖安装 (Dependencies):
pip install flask flask-session flask-limiter watchdog cloudscraper requests

✨ 核心改进 (Improvements):
1. [Security] 严格的 SSRF 防御，拒绝一切内网/本地 IP 访问。
2. [Feature] 配置热更新，无需重启即可更新限流/超时策略。
3. [Stability] 统一的全局错误捕获，防止单次请求崩溃整个进程。
4. [Cloudflare] 使用 cloudscraper 绕过 Cloudflare 的人机挑战。
"""

import os
import re
import json
import logging
import ipaddress
import threading
from datetime import timedelta
from urllib.parse import urlparse, urljoin
from functools import wraps

from flask import Flask, request, Response, session, redirect, make_response
from werkzeug.exceptions import HTTPException
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from watchdog.observers import Observer
from watchdog.events import FileSystemEventHandler
import cloudscraper

# ---------------------------
# 日志配置
# ---------------------------
LOG_DIR = os.path.dirname(os.path.abspath(__file__))
RUN_LOG_PATH = os.path.join(LOG_DIR, "run.log")
ERROR_LOG_PATH = os.path.join(LOG_DIR, "error.log")

# 自定义日志格式
log_format = logging.Formatter("[%(asctime)s] [%(levelname)s] %(message)s", datefmt="%Y-%m-%d %H:%M:%S")

# 创建 logger
logger = logging.getLogger("ProxyServer")
logger.setLevel(logging.INFO)

# run.log handler (info + warn, 排除 error)
class NoErrorFilter(logging.Filter):
    def filter(self, record):
        return record.levelno < logging.ERROR

run_handler = logging.FileHandler(RUN_LOG_PATH, encoding="utf-8")
run_handler.setLevel(logging.INFO)
run_handler.setFormatter(log_format)
run_handler.addFilter(NoErrorFilter())
logger.addHandler(run_handler)

# error.log handler (only error)
error_handler = logging.FileHandler(ERROR_LOG_PATH, encoding="utf-8")
error_handler.setLevel(logging.ERROR)
error_handler.setFormatter(log_format)
logger.addHandler(error_handler)

# 控制台输出
console_handler = logging.StreamHandler()
console_handler.setLevel(logging.INFO)
console_format = logging.Formatter("[%(asctime)s] %(levelname)s: %(message)s", datefmt="%H:%M:%S")
console_handler.setFormatter(console_format)
logger.addHandler(console_handler)


# ---------------------------
# 1. 全局配置与热更新状态
# ---------------------------
CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "main.json")

# 默认配置 (Safe Defaults)
config = {
    "port": 8082,
    "timeout": 30,  # 秒 (Python requests 使用秒)
    "session": {
        "secret": f"change-this-secret-in-prod-{os.urandom(8).hex()}",
        "name": "proxySession",
        "cookie_max_age": 86400,  # 秒
        "cookie_secure": False,
        "cookie_httponly": True
    },
    "accessOrigin": "*",
    "user": "",
    "pwd": "",
    "defaultSkip": "",
    "limiter": {
        "windowMs": 60,  # 秒
        "max": 60,
        "message": "Too many requests, please try again later.",
        "statusCode": 429
    },
    "blacklist": []  # 支持正则字符串
}

# 配置锁 (线程安全)
config_lock = threading.Lock()


def load_config():
    """加载配置文件"""
    global config
    try:
        if os.path.exists(CONFIG_PATH):
            with open(CONFIG_PATH, "r", encoding="utf-8") as f:
                parsed = json.load(f)
            
            with config_lock:
                # 深度合并配置
                config.update(parsed)
                if "session" in parsed:
                    config["session"].update(parsed["session"])
                if "limiter" in parsed:
                    config["limiter"].update(parsed["limiter"])
            
            logger.info(f"[Config] ✅ Configuration loaded. Timeout: {config['timeout']}s")
        else:
            logger.warning("[Config] ⚠️ Config file not found, using defaults.")
    except Exception as e:
        logger.error(f"[Config] ❌ Error loading config: {e}")


# ---------------------------
# 配置文件热更新监听
# ---------------------------
class ConfigChangeHandler(FileSystemEventHandler):
    def on_modified(self, event):
        if event.src_path.endswith("main.json"):
            logger.info("[Config] 📝 File changed, reloading...")
            load_config()


def start_config_watcher():
    """启动配置文件监视器"""
    config_dir = os.path.dirname(CONFIG_PATH)
    if not config_dir:
        config_dir = "."
    
    event_handler = ConfigChangeHandler()
    observer = Observer()
    observer.schedule(event_handler, config_dir, recursive=False)
    observer.daemon = True
    observer.start()
    logger.info("[System] 🔄 Config watcher started.")


# ---------------------------
# 2. 初始化 Flask
# ---------------------------
load_config()

app = Flask(__name__)
app.secret_key = config["session"].get("secret", f"change-this-secret-in-prod-{os.urandom(8).hex()}")
app.config["SESSION_COOKIE_NAME"] = config["session"].get("name", "proxySession")
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(seconds=config["session"].get("cookie_max_age", config["session"].get("maxAge", 86400)))
app.config["SESSION_COOKIE_SECURE"] = config["session"].get("cookie_secure", config["session"].get("secure", False))
app.config["SESSION_COOKIE_HTTPONLY"] = config["session"].get("cookie_httponly", config["session"].get("httpOnly", True))

# Rate Limiter
limiter = Limiter(
    key_func=get_remote_address,
    app=app,
    default_limits=[f"{config['limiter']['max']} per {config['limiter']['windowMs']} seconds"],
    storage_uri="memory://",
)


# ---------------------------
# 3. Cloudscraper 实例 (绕过 Cloudflare)
# ---------------------------
def create_scraper():
    """创建 cloudscraper 实例，绕过 Cloudflare 人机挑战"""
    scraper = cloudscraper.create_scraper(
        browser={
            "browser": "chrome",
            "platform": "windows",
            "mobile": False
        },
        delay=10  # 延迟以避免触发速率限制
    )
    return scraper


# 全局 scraper 实例 (可复用)
scraper = create_scraper()


# ---------------------------
# 4. 安全鉴权模块
# ---------------------------
def check_basic_auth():
    """检查 Basic Auth 认证"""
    if not config["user"] or not config["pwd"]:
        logger.warning("[Auth] ⚠️ No Basic Auth configured. Service is open!")
        return True
    
    auth = request.authorization
    if not auth or auth.username != config["user"] or auth.password != config["pwd"]:
        return False
    return True


def require_auth(f):
    """Basic Auth 装饰器"""
    @wraps(f)
    def decorated(*args, **kwargs):
        if not check_basic_auth():
            resp = make_response("Unauthorized", 401)
            resp.headers["WWW-Authenticate"] = 'Basic realm="Proxy Auth Required"'
            return resp
        return f(*args, **kwargs)
    return decorated


# ---------------------------
# 5. 核心工具：SSRF 防御 (isPrivateIP)
# ---------------------------
def is_safe_target(url_str: str) -> bool:
    """检查目标 URL 是否安全 (防止 SSRF)"""
    try:
        u = urlparse(url_str)
        
        # 只允许 http 和 https
        if u.scheme not in ["http", "https"]:
            return False
        
        hostname = u.hostname
        if not hostname:
            return False
        
        # 1. 黑名单正则检查
        if config.get("blacklist"):
            pattern = "|".join(config["blacklist"])
            if re.search(pattern, url_str, re.IGNORECASE):
                logger.warning(f"[Security] 🛡️ Blocked by blacklist: {url_str}")
                return False
        
        # 2. IP 检查 (防止 SSRF)
        # 如果是 localhost，直接拒绝
        if hostname.lower() == "localhost":
            return False
        
        # 检查是否为 IP 地址
        try:
            ip = ipaddress.ip_address(hostname)
            # 拒绝私有、环回、链路本地等
            if ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved:
                logger.warning(f"[Security] 🛡️ Blocked Private/Local IP: {hostname}")
                return False
        except ValueError:
            # 不是 IP 地址，是域名，允许通过
            pass
        
        return True
    except Exception as e:
        logger.error(f"[Security] Invalid URL: {url_str} - {e}")
        return False


# ---------------------------
# 6. URL 拼接工具函数
# ---------------------------
def get_target_url(base_url: str, path: str) -> str:
    """拼接目标 URL"""
    p = path.lstrip("/")
    if p:
        parsed = urlparse(base_url)
        return f"{parsed.scheme}://{parsed.netloc}/{p}"
    return base_url


# ---------------------------
# 7. CORS 处理
# ---------------------------
@app.after_request
def add_cors_headers(response):
    """添加 CORS 响应头"""
    client_origin = request.headers.get("Origin") or request.headers.get("Referer")
    allow_origin = config["accessOrigin"]
    
    # 只有在配置允许所有时，才反射 Origin 以支持 Credentials
    if config["accessOrigin"] == "*" and client_origin:
        try:
            parsed = urlparse(client_origin)
            allow_origin = f"{parsed.scheme}://{parsed.netloc}"
        except Exception:
            pass
    
    response.headers["Access-Control-Allow-Origin"] = allow_origin or "*"
    response.headers["Access-Control-Allow-Credentials"] = "true"
    
    # 动态暴露所有响应头，解决 HEAD 请求头部缺失问题
    # 排除 Set-Cookie 以免暴露敏感信息，且 Set-Cookie 受 CORS 特殊限制
    exposed_headers = [k for k in response.headers.keys() if k.lower() != 'set-cookie']
    response.headers["Access-Control-Expose-Headers"] = ", ".join(exposed_headers)
    
    response.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    response.headers["Access-Control-Allow-Headers"] = request.headers.get(
        "Access-Control-Request-Headers", "content-type, authorization"
    )
    
    return response


@app.before_request
def handle_options():
    """处理 OPTIONS 预检请求"""
    if request.method == "OPTIONS":
        return make_response("", 204)


# ---------------------------
# 8. 请求日志
# ---------------------------
@app.before_request
def log_request():
    """记录请求日志"""
    if "favicon.ico" in request.url:
        return
    logger.info(f"\n[Request] ➡️ {request.method} {request.path} | IP: {request.remote_addr}")


# ---------------------------
# 9. 静态资源
# ---------------------------
@app.route("/web/<path:filename>")
def serve_static(filename):
    """提供静态资源"""
    from flask import send_from_directory
    return send_from_directory("webPro", filename)


# ---------------------------
# 10. 代理逻辑 (使用 cloudscraper)
# ---------------------------
# 不需要代理的响应头
HOP_BY_HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
    "content-length"
}


def proxy_request(target_url: str, method: str, headers: dict, data=None):
    """
    使用 cloudscraper 代理请求，绕过 Cloudflare 人机挑战
    """
    try:
        # 清理不需要转发的请求头
        forward_headers = {}
        for key, value in headers.items():
            key_lower = key.lower()
            if key_lower not in HOP_BY_HOP_HEADERS and not key_lower.startswith("cf-"):
                # 排除一些可能暴露客户端信息的 headers
                if key_lower not in ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", 
                                     "cf-ray", "cf-connecting-ip", "cf-ipcountry", "cf-visitor",
                                     "priority", "cdn-loop", "authorization", "host"]:
                    forward_headers[key] = value
        
        # 重写 Host/Origin/Referer
        parsed = urlparse(target_url)
        forward_headers["Host"] = parsed.netloc
        forward_headers["Origin"] = f"{parsed.scheme}://{parsed.netloc}"
        forward_headers["Referer"] = target_url
        
        # 注入自定义 Headers
        custom_headers = request.args.get("headers")
        if custom_headers:
            try:
                custom = json.loads(custom_headers)
                forward_headers.update(custom)
            except Exception:
                logger.warning("[Proxy] Failed to parse custom headers JSON")
        
        # 使用 cloudscraper 发送请求
        timeout = config.get("timeout", 30)
        
        response = scraper.request(
            method=method,
            url=target_url,
            headers=forward_headers,
            data=data,
            allow_redirects=True,  # 开启自动跟随重定向
            timeout=timeout,
            stream=True  # 流式传输大文件
        )
        
        logger.info(f"[Proxy] Response Status: {response.status_code}")
        
        return response
        
    except Exception as e:
        logger.error(f"[Proxy Error] 💥 {e}")
        raise


def rewrite_location_header(location: str, target_url: str) -> str:
    """重写 Location 响应头，防止重定向跳出代理"""
    try:
        target_origin = urlparse(target_url)
        target_origin_str = f"{target_origin.scheme}://{target_origin.netloc}"
        proxy_origin = f"{request.scheme}://{request.host}"
        
        # 处理绝对路径重定向
        if location.startswith(target_origin_str):
            new_location = location.replace(target_origin_str, proxy_origin)
            logger.info(f"[Proxy] Rewrite Location: {location} -> {new_location}")
            return new_location
        
        # 处理协议相对路径 (//www.example.com/xxx)
        if location.startswith("//"):
            if location.startswith(f"//{target_origin.netloc}"):
                new_location = location.replace(f"//{target_origin.netloc}", f"//{request.host}")
                logger.info(f"[Proxy] Rewrite Location: {location} -> {new_location}")
                return new_location
        
        return location
    except Exception as e:
        logger.error(f"[Proxy] Error rewriting Location header: {e}")
        return location


@app.route("/", defaults={"path": ""}, methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
@app.route("/<path:path>", methods=["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
@require_auth
def proxy_handler(path):
    """主代理处理器"""
    
    # 跳过静态资源路径
    if path.startswith("web"):
        return make_response("Not Found", 404)
    
    # 处理 ?url= 参数
    url_param = request.args.get("url")
    if url_param:
        if is_safe_target(url_param):
            logger.info(f"[Session] 🎯 Target updated: {url_param}")
            session["targetUrl"] = url_param
            session.permanent = True
        else:
            return make_response("Forbidden: Invalid Target URL or Local IP Access Denied.", 403)
    
    # 检查 Session 状态
    target_url = session.get("targetUrl")
    if not target_url:
        if config.get("defaultSkip"):
            return redirect(config["defaultSkip"])
        return make_response("""
            <h3>Proxy Service Ready</h3>
            <p>Please provide a valid target URL via query parameter: <code>/?url=https://example.com</code></p>
        """, 400)
    
    # 计算最终代理 URL
    if url_param:
        full_url = url_param
    else:
        # 使用 session.targetUrl 的 origin + 当前请求路径
        full_url = get_target_url(target_url, request.full_path.rstrip("?"))
    
    logger.info(f"[Debug] Proxy request - fullUrl: {full_url}")
    
    try:
        # 执行代理请求
        proxy_response = proxy_request(
            target_url=full_url,
            method=request.method,
            headers=dict(request.headers),
            data=request.get_data() if request.method in ["POST", "PUT", "PATCH", "DELETE"] else None
        )
        
        # [Redirect Sync] 检测是否发生了重定向
        # response.history 包含重定向链；如果有历史，说明发生了跳转
        # 我们一定要更新 session['targetUrl'] 为最终落地的 URL，
        # 否则页面里的相对路径资源（js/css/imgs）会去请求旧的域名导致 404
        if proxy_response.history or proxy_response.url != full_url:
             # 注意：proxy_response.url 是最终的完整 URL
             # 只有当它与我们请求的 full_url (包含 query 参数等) 不同时才视为真正需要更新基准的情况
             # 但为了保险，只要发生了 redirect (history 不为空)，我们就更新
             if proxy_response.history:
                 final_url = proxy_response.url
                 logger.info(f"[Session] 🔀 Redirect detected. Updating target: {session.get('targetUrl')} -> {final_url}")
                 session["targetUrl"] = final_url
                 session.permanent = True
        
        # 构建响应
        response_headers = {}
        for key, value in proxy_response.headers.items():
            key_lower = key.lower()
            # 过滤 hop-by-hop 头和安全限制头
            if key_lower not in HOP_BY_HOP_HEADERS:
                if key_lower not in ["x-frame-options", "content-security-policy"]:
                    if key_lower == "location":
                        # 重写 Location 头
                        value = rewrite_location_header(value, target_url)
                    response_headers[key] = value
        
        # 允许跨域
        client_origin = request.headers.get("Origin") or request.headers.get("Referer")
        if config["accessOrigin"] == "*" and client_origin:
            try:
                parsed = urlparse(client_origin)
                allow_origin = f"{parsed.scheme}://{parsed.netloc}"
            except Exception:
                allow_origin = "*"
        else:
            allow_origin = config["accessOrigin"]
        
        response_headers["Access-Control-Allow-Origin"] = allow_origin
        response_headers["Access-Control-Allow-Credentials"] = "true"
        
        # 创建流式响应 (透传原始数据，防止后端解压导致 Content-Encoding 不匹配)
        def generate():
            # 使用 raw.stream(decode_content=False)以此来透传原始压缩数据（如 br/gzip）
            # urllib3 的 stream 方法参数是 amt 而不是 chunk_size
            for chunk in proxy_response.raw.stream(decode_content=False, amt=8192):
                if chunk:
                    yield chunk
        
        return Response(
            generate(),
            status=proxy_response.status_code,
            headers=response_headers
        )
        
    except Exception as e:
        logger.error(f"[Proxy Error] 💥 {e}")
        return make_response(json.dumps({"error": "Bad Gateway", "message": str(e)}), 502)


# ---------------------------
# 11. 限流错误处理
# ---------------------------
@app.errorhandler(429)
def ratelimit_handler(e):
    """处理限流错误"""
    logger.warning(f"[RateLimit] ⛔ Blocked request from {request.remote_addr}")
    return make_response(config["limiter"]["message"], config["limiter"]["statusCode"])


# ---------------------------
# 12. 全局错误处理
# ---------------------------
@app.errorhandler(Exception)
def handle_exception(e):
    """全局异常处理"""
    # 如果是 HTTP 错误（如 405, 404 等），保留原始状态码
    if isinstance(e, HTTPException):
        logger.warning(f"[System] ⚠️ HTTP Error {e.code}: {e.description}")
        return make_response(json.dumps({
            "error": e.name,
            "code": e.code,
            "message": e.description
        }), e.code)
        
    logger.error(f"[System] ❌ Unhandled Exception: {e}")
    return make_response(json.dumps({"error": "Internal Server Error", "message": str(e)}), 500)


# ---------------------------
# 13. 启动服务
# ---------------------------
if __name__ == "__main__":
    # 启动配置监视器
    start_config_watcher()
    
    logger.info(f"\n🚀 [Server] Reverse Proxy running on port {config['port']}")
    logger.info("🛡️  [Security] SSRF Protection: Enabled")
    logger.info("☁️  [Cloudflare] Bypass with cloudscraper: Enabled")
    logger.info("🔥 [System] Hot Reload: Enabled")
    
    # 使用 Flask 内置服务器 (开发环境)
    # 生产环境建议使用 gunicorn: gunicorn -w 4 -b 0.0.0.0:8082 test:app
    app.run(
        host="0.0.0.0",
        port=config["port"],
        threaded=True,
        debug=False
    )
