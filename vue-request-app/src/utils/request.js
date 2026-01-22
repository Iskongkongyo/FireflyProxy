/**
 * 请求处理工具函数
 * 提取公共的 URL 构建、请求头处理、媒体类型检测等逻辑
 */

import { PROXY_CONFIG, MEDIA_CONFIG } from '../config.js';

/**
 * 构建代理请求 URL
 * @param {string} targetUrl - 目标 URL
 * @param {Object} headers - 请求头对象
 * @returns {string} 代理请求 URL
 */
export function buildProxyUrl(targetUrl, headers = {}) {
    const baseUrl = PROXY_CONFIG.BASE_URL;
    const encodedUrl = encodeURIComponent(targetUrl);
    let url = `${baseUrl}/?url=${encodedUrl}`;

    if (Object.keys(headers).length > 0) {
        const encodedHeaders = encodeURIComponent(JSON.stringify(headers));
        url += `&headers=${encodedHeaders}`;
    }
    return url;
}

/**
 * 处理请求头数组，转换为对象格式
 * @param {Array<{key: string, value: string}>} headersArray - 请求头数组
 * @returns {Object} 请求头对象
 */
export function processHeaders(headersArray) {
    const result = {};
    if (!Array.isArray(headersArray)) return result;

    headersArray.forEach(item => {
        if (item && item.key) {
            result[item.key] = item.value || '';
        }
    });

    return result;
}

/**
 * 处理搜索参数，过滤空值并转为 JSON 字符串
 * @param {Array<{key: string, value: string}>} params - 参数数组
 * @returns {string} JSON 字符串或空字符串
 */
export function handleSearchParams(params) {
    if (!Array.isArray(params)) return '';

    const result = params.filter(item => item && item.key);
    return result.length > 0 ? JSON.stringify(result) : '';
}

/**
 * 获取文件扩展名
 * @param {string} url - 文件 URL
 * @returns {string} 扩展名（小写，不含点）
 */
export function getFileExtension(url) {
    if (!url) return '';
    const match = url.match(/\.([0-9a-z]+)(?:[?#]|$)/i);
    return match ? match[1].toLowerCase() : '';
}

/**
 * 检测是否为媒体 URL（视频或音频）
 * @param {string} url - 文件 URL
 * @returns {boolean}
 */
export function isMediaUrl(url) {
    const ext = getFileExtension(url);
    const allMediaExts = [...MEDIA_CONFIG.VIDEO_EXTENSIONS, ...MEDIA_CONFIG.AUDIO_EXTENSIONS];
    return allMediaExts.includes(ext);
}

/**
 * 获取媒体类型
 * @param {string} url - 文件 URL
 * @returns {'video' | 'audio' | null}
 */
export function getMediaType(url) {
    const ext = getFileExtension(url);
    if (MEDIA_CONFIG.VIDEO_EXTENSIONS.includes(ext)) return 'video';
    if (MEDIA_CONFIG.AUDIO_EXTENSIONS.includes(ext)) return 'audio';
    return null;
}

/**
 * 构建完整的目标 URL（带查询参数）
 * @param {string} baseUrl - 基础 URL
 * @param {Array<{key: string, value: string}>} params - 查询参数数组
 * @returns {string} 完整 URL
 */
export function buildTargetUrl(baseUrl, params = []) {
    try {
        const url = new URL(baseUrl);
        params.forEach(item => {
            if (item && item.key) {
                url.searchParams.append(item.key, item.value || '');
            }
        });
        return url.toString();
    } catch (e) {
        console.error('Invalid URL:', baseUrl);
        return baseUrl;
    }
}

/**
 * 格式化字节大小
 * @param {number} bytes - 字节数
 * @returns {string} 格式化后的大小
 */
export function formatBytes(bytes) {
    if (!bytes || bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${units[i]}`;
}
