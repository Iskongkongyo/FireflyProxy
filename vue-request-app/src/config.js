/**
 * 应用配置文件
 * 将环境相关的配置集中管理，方便不同环境部署
 */

// 代理服务器配置
export const PROXY_CONFIG = {
    // 代理服务器地址 - 开发环境使用 localhost，生产环境可改为实际部署地址
    BASE_URL: process.env.VUE_APP_PROXY_URL || 'http://localhost:8082',

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
