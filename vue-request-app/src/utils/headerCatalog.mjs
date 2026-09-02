export const COMMON_REQUEST_HEADERS = Object.freeze([
	{ value: 'Accept', description: '期望的响应媒体类型，例如 application/json' },
	{ value: 'Accept-Encoding', description: '可接受的响应压缩格式，例如 gzip, br' },
	{ value: 'Accept-Language', description: '首选响应语言，例如 zh-CN,zh;q=0.9' },
	{ value: 'Authorization', description: '上游认证信息；也可在“身份认证”页签配置' },
	{ value: 'Cache-Control', description: '请求缓存策略，例如 no-cache' },
	{ value: 'Content-Encoding', description: '请求体所使用的内容编码' },
	{ value: 'Content-Type', description: '请求体媒体类型，例如 application/json' },
	{ value: 'Cookie', description: '发送给目标站点的 Cookie，不会写入代理站点' },
	{ value: 'DNT', description: '请勿跟踪偏好，常用值为 1' },
	{ value: 'Idempotency-Key', description: '幂等请求标识，避免重复执行写操作' },
	{ value: 'If-Match', description: '仅在资源 ETag 匹配时执行请求' },
	{ value: 'If-Modified-Since', description: '资源未更新时允许返回 304' },
	{ value: 'If-None-Match', description: '资源 ETag 未匹配时执行请求' },
	{ value: 'If-Unmodified-Since', description: '仅在资源未更新时执行请求' },
	{ value: 'Origin', description: '请求来源，例如 https://example.com' },
	{ value: 'Pragma', description: '兼容旧式缓存控制，常用值为 no-cache' },
	{ value: 'Prefer', description: '声明期望的服务端处理偏好' },
	{ value: 'Range', description: '请求部分内容，例如 bytes=0-1023' },
	{ value: 'Referer', description: '来源页面完整地址，例如 https://example.com/page' },
	{ value: 'User-Agent', description: '发送给目标服务的客户端标识' },
	{ value: 'X-Api-Key', description: '常见 API 密钥请求头' },
	{ value: 'X-Request-ID', description: '用于链路追踪的请求标识' },
	{ value: 'X-Requested-With', description: '传统 Ajax 请求标记' }
]);

export function filterHeaderSuggestions(query = '') {
	const keyword = String(query).trim().toLowerCase();
	if (!keyword) return [...COMMON_REQUEST_HEADERS];
	return COMMON_REQUEST_HEADERS.filter(({ value, description }) =>
		value.toLowerCase().includes(keyword) || description.toLowerCase().includes(keyword)
	);
}
