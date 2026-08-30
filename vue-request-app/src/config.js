/**
 * 应用配置文件
 * 将环境相关的配置集中管理，方便不同环境部署
 */

const DEFAULT_PROXY_URL = 'http://localhost:8082';
const LEGACY_PROXY_URL = process.env.VUE_APP_PROXY_URL || DEFAULT_PROXY_URL;

// 代理服务器配置
export const PROXY_CONFIG = {
    // BASE_URL 保留为 API 请求页兼容字段。
    BASE_URL: process.env.VUE_APP_PROXY_API_URL || LEGACY_PROXY_URL,
    API_BASE_URL: process.env.VUE_APP_PROXY_API_URL || LEGACY_PROXY_URL,
    BROWSER_BASE_URL: process.env.VUE_APP_PROXY_BROWSE_URL || LEGACY_PROXY_URL,

    // 请求超时时间 (毫秒)
    TIMEOUT: 60000,
};

// 媒体类型配置
export const MEDIA_CONFIG = {
    // 视频扩展名
    VIDEO_EXTENSIONS: ['mp4', 'webm', 'ogg', 'mkv', 'avi', 'mov', 'wmv', 'flv', 'm3u8', 'ts'],

    // 音频扩展名
    AUDIO_EXTENSIONS: ['mp3', 'wav', 'flac', 'aac', 'm4a'],
};

// URL 正则表达式
export const URL_PATTERN = /https?:\/\/[^\s/$.?#].[^\s]*/;

// 导出默认配置
export default {
    PROXY_CONFIG,
    MEDIA_CONFIG,
    URL_PATTERN,
};
