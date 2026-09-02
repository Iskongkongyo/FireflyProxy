/**
 * 错误处理工具函数
 * 根据 HTTP 状态码和错误类型提供友好的错误提示
 */

// HTTP 状态码错误信息映射
const HTTP_ERROR_MESSAGES = {
    // 4xx 客户端错误
    400: '请求参数错误，请检查输入内容',
    401: '身份验证失败，请检查认证信息',
    403: '访问被拒绝，目标服务器禁止访问此资源',
    404: '资源未找到，请检查 URL 是否正确',
    405: '请求方法不被允许，请尝试其他方法',
    408: '请求超时，请稍后重试',
    413: '请求体过大，请减少数据量',
    414: 'URL 过长，请简化请求参数',
    415: '不支持的媒体类型，请检查 Content-Type',
    429: '请求过于频繁，请稍后再试',

    // 5xx 服务器错误
    500: '目标服务器内部错误',
    501: '目标服务器不支持此功能',
    502: '网关错误，无法连接到目标服务器',
    503: '目标服务器暂时不可用，请稍后重试',
    504: '网关超时，目标服务器响应过慢',
};

// 代理特定错误信息
const PROXY_ERROR_MESSAGES = {
    SSRF_BLOCKED: '安全限制：禁止访问内网/本地地址',
    BLACKLISTED: '此域名在黑名单中，禁止访问',
    INVALID_URL: 'URL 格式无效，请输入正确的网址',
    CONNECTION_REFUSED: '无法连接到目标服务器',
    DNS_FAILED: '域名解析失败，请检查网址是否正确',
    SSL_ERROR: 'SSL/TLS 证书验证失败',
    TIMEOUT: '请求超时，目标服务器响应过慢',
};

/**
 * 解析错误并返回友好的错误信息
 * @param {Error|Object} error - 错误对象
 * @returns {Object} { message: string, type: string, details: string }
 */
export function parseError(error) {
    const result = {
        message: '请求失败',
        type: 'error',
        details: ''
    };

    // Axios 错误
    if (error.response) {
        const status = error.response.status;
        result.message = HTTP_ERROR_MESSAGES[status] || `服务器返回错误 (${status})`;
        result.type = status >= 500 ? 'error' : 'warning';
        result.details = `HTTP ${status}`;

        // 尝试从响应体获取更多信息
        if (error.response.data) {
            if (typeof error.response.data === 'string') {
                // 检查代理特定错误
                const data = error.response.data.toLowerCase();
                if (data.includes('forbidden') && data.includes('local ip')) {
                    result.message = PROXY_ERROR_MESSAGES.SSRF_BLOCKED;
                } else if (data.includes('blacklist')) {
                    result.message = PROXY_ERROR_MESSAGES.BLACKLISTED;
                }
            } else if (error.response.data.message) {
                result.details = error.response.data.message;
            }
        }
    }
    // 网络错误（无响应）
    else if (error.request) {
        if (error.code === 'ECONNABORTED' || error.message?.includes('timeout')) {
            result.message = PROXY_ERROR_MESSAGES.TIMEOUT;
            result.type = 'warning';
        } else if (error.message?.includes('Network Error')) {
            result.message = '无法读取代理响应，请检查代理服务与 CORS 配置';
            result.type = 'error';
            result.details = 'Network Error（浏览器可能因跨域策略拦截响应）';
        } else {
            result.message = '无法连接到代理服务器';
            result.type = 'error';
        }
        if (!result.details) result.details = error.message || '请检查网络连接';
    }
    // 其他错误
    else if (error.message) {
        result.message = error.message;
        result.details = error.stack || '';
    }

    return result;
}

/**
 * 获取 HTTP 状态码的简短描述
 * @param {number} status - HTTP 状态码
 * @returns {string}
 */
export function getStatusText(status) {
    const statusTexts = {
        200: 'OK',
        201: 'Created',
        204: 'No Content',
        301: 'Moved Permanently',
        302: 'Found',
        304: 'Not Modified',
        400: 'Bad Request',
        401: 'Unauthorized',
        403: 'Forbidden',
        404: 'Not Found',
        405: 'Method Not Allowed',
        500: 'Internal Server Error',
        502: 'Bad Gateway',
        503: 'Service Unavailable',
        504: 'Gateway Timeout',
    };
    return statusTexts[status] || 'Unknown';
}

/**
 * 判断状态码是否表示成功
 * @param {number} status - HTTP 状态码
 * @returns {boolean}
 */
export function isSuccessStatus(status) {
    return status >= 200 && status < 300;
}

export default {
    parseError,
    getStatusText,
    isSuccessStatus,
    HTTP_ERROR_MESSAGES,
    PROXY_ERROR_MESSAGES,
};
