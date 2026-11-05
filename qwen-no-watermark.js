// ==UserScript==
// @name         千问无水印图片下载
// @namespace    https://github.com/chushijack/qwen-no-watermark
// @version      1.0.3
// @description  千问AI生图下载没有水印的原图
// @author       ChushiJack
// @license      GPL-3.0
// @csdnURL      https://blog.csdn.net/2301_77607029
// @homepageURL  https://github.com/chushijack/qwen-no-watermark
// @supportURL   https://github.com/chushijack/qwen-no-watermark/issues
// @downloadURL  https://raw.githubusercontent.com/chushijack/qwen-no-watermark/main/qwen-no-watermark.user.js
// @updateURL    https://raw.githubusercontent.com/chushijack/qwen-no-watermark/main/qwen-no-watermark.user.js
// @match        https://www.qianwen.com/chat/*
// @run-at       document-start
// @icon         https://img.alicdn.com/imgextra/i2/O1CN01taBbMS1CfyJoOt0lB_!!6000000000109-2-tps-80-80.png
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    // 在 baxia/itrace 劫持 fetch 之前保存原生 fetch，用于下载图片
    const nativeFetch = window.fetch.bind(window);

    const API_URL_HINTS = [
        '/api/v1/session/msg/list',
        '/api/v1/chat/snap',
        '/api/v1/share/info',
        '/api/v2/chat',
        '/api/v1/chat/cancel',
    ];

    const CDN_HOST_HINTS = [
        'workspace-zb-cdn.qianwen.com',
        'workspace-zb-cdn.quark.cn',
        'qianwen.com',
        'quark.cn',
        'alicdn.com',
        'aliyuncs.com',
    ];

    // 展示图 URL -> 接口 image 原图
    const urlToCleanUrl = new Map();

    // 已挂载下载按钮的图片元素
    const elementButtons = new WeakMap();

    let hookInstalled = false;
    let loggedReady = false;
    let loggedMapSize = 0;

    // 设为 true 可在控制台查看接口解析与下载细节
    const DEBUG = false;

    function debugLog(...args) {
        if (DEBUG) {
            console.log(...args);
        }
    }

    function debugWarn(...args) {
        if (DEBUG) {
            console.warn(...args);
        }
    }

    function buildDownloadAttempts(normalizedUrl, sourceElement) {
        const attempts = [];

        if (sourceElement instanceof HTMLImageElement) {
            attempts.push(() => requestBlobFromVisibleImage(sourceElement, normalizedUrl));
        }
        attempts.push(
            () => requestBlobViaCrossOriginImage(normalizedUrl),
            async () => {
                const response = await nativeFetch(normalizedUrl, {
                    credentials: 'include',
                    mode: 'cors',
                    referrerPolicy: 'strict-origin-when-cross-origin',
                });
                if (!response.ok) {
                    throw new Error(`HTTP ${response.status}`);
                }
                return response.blob();
            },
            () => requestBlobViaXHR(normalizedUrl),
        );

        return attempts;
    }

    function normalizeProtocol(url) {
        if (!url) {
            return url;
        }
        if (window.location.protocol === 'https:' && url.startsWith('http://')) {
            return url.replace('http://', 'https://');
        }
        return url;
    }

    function normalizeUrlKey(url) {
        if (!url) {
            return '';
        }
        try {
            const parsed = new URL(url, window.location.origin);
            return `${parsed.origin}${parsed.pathname}`;
        } catch {
            return url.split('?')[0];
        }
    }

    function registerUrlPair(displayUrl, cleanUrl) {
        const clean = normalizeProtocol(cleanUrl);
        if (!clean) {
            return false;
        }
        urlToCleanUrl.set(normalizeUrlKey(clean), clean);
        if (displayUrl) {
            urlToCleanUrl.set(normalizeUrlKey(displayUrl), clean);
        }
        return true;
    }

    function pickUrl(value) {
        if (!value) {
            return '';
        }
        if (typeof value === 'string') {
            return value;
        }
        if (Array.isArray(value)) {
            return pickUrl(value[0]);
        }
        if (typeof value === 'object' && typeof value.url === 'string') {
            return value.url;
        }
        return '';
    }

    function shouldIngestRequest(url) {
        if (!url || typeof url !== 'string') {
            return false;
        }
        if (!url.includes('qianwen.com')) {
            return false;
        }
        return API_URL_HINTS.some((hint) => url.includes(hint));
    }

    function extractImageMetadata(element) {
        const metadata = {};
        Array.from(element.attributes).forEach((attr) => {
            if (!attr.name.startsWith('data-') || attr.name === 'data-image-context') {
                return;
            }
            const key = attr.name
                .slice(5)
                .replace(/-([a-z])/g, (_, char) => char.toUpperCase());
            try {
                metadata[key] = JSON.parse(attr.value);
            } catch {
                metadata[key] = attr.value;
            }
        });
        return metadata;
    }

    // 接口 display.image 原图 URL（pathname 归一化）
    const apiOriginalPathKeys = new Set();

    function rememberApiOriginalUrl(url) {
        const normalized = normalizeProtocol(url);
        if (!normalized) {
            return;
        }
        apiOriginalPathKeys.add(normalizeUrlKey(normalized));
    }

    function resolveDownloadUrlFromMetadata(metadata, fallbackUrl) {
        const mapped = urlToCleanUrl.get(normalizeUrlKey(fallbackUrl));
        if (mapped) {
            return mapped;
        }

        const watermarkUrl = metadata.imageWatermarkUrl;
        const actions = typeof metadata.imageWatermarkActions === 'string'
            ? metadata.imageWatermarkActions.split(',').map((item) => item.trim().toLowerCase())
            : ['copy', 'download'];

        if (watermarkUrl && actions.includes('download')) {
            return normalizeProtocol(watermarkUrl);
        }

        const fallback = normalizeProtocol(fallbackUrl);
        if (fallback && apiOriginalPathKeys.has(normalizeUrlKey(fallback))) {
            return fallback;
        }

        return fallback;
    }

    function resolveDownloadUrl(element, fallbackUrl) {
        const metadata = extractImageMetadata(element);
        return resolveDownloadUrlFromMetadata(metadata, fallbackUrl);
    }

    function isLikelyGeneratedUrl(url) {
        if (!url || url.startsWith('data:')) {
            return false;
        }
        try {
            const hostname = new URL(url, window.location.origin).hostname.toLowerCase();
            return CDN_HOST_HINTS.some((hint) => hostname === hint || hostname.endsWith(`.${hint}`));
        } catch {
            return false;
        }
    }

    function isLargeEnough(element) {
        const rect = element.getBoundingClientRect();
        return rect.width >= 96 && rect.height >= 96;
    }

    function isInChatSurface(element) {
        return !!element.closest('main, [role="main"], [class*="message"], [class*="answer"], [class*="chat"]');
    }

    function isGeneratedChatImage(img) {
        if (!(img instanceof HTMLImageElement)) {
            return false;
        }
        if (!img.src || img.src.startsWith('data:')) {
            return false;
        }
        if (img.hasAttribute('data-image-watermark-url') || img.hasAttribute('data-image-context')) {
            return isLargeEnough(img);
        }
        if (!isLargeEnough(img)) {
            return false;
        }
        if (!isLikelyGeneratedUrl(img.src)) {
            return false;
        }
        return isInChatSurface(img);
    }

    function getBackgroundImageUrl(element) {
        const bg = window.getComputedStyle(element).backgroundImage;
        if (!bg || bg === 'none') {
            return '';
        }
        const match = bg.match(/url\(["']?(.+?)["']?\)/);
        return match?.[1] || '';
    }

    function isGeneratedBackgroundElement(element) {
        if (!(element instanceof HTMLElement) || element.tagName === 'IMG') {
            return false;
        }
        if (!element.hasAttribute('data-image-context')) {
            return false;
        }
        const url = getBackgroundImageUrl(element);
        if (!url || !isLikelyGeneratedUrl(url)) {
            return false;
        }
        return isLargeEnough(element);
    }

    function summarizeDisplayUrls(display) {
        const imageUrl = pickUrl(display.image);
        const watermarkUrl = pickUrl(display.watermark_image);
        const aiWatermarkUrl = pickUrl(display.ai_watermark_image);
        const brandWatermarkUrl = pickUrl(display.brand_watermark_image);

        const keys = [imageUrl, watermarkUrl, aiWatermarkUrl, brandWatermarkUrl]
            .filter(Boolean)
            .map(normalizeUrlKey);
        const uniqueKeys = new Set(keys);

        return {
            type: display.type,
            // 接口 field `image` 为原图，下载应使用此 URL
            'image（原图）': imageUrl,
            watermark_image: watermarkUrl,
            ai_watermark_image: aiWatermarkUrl,
            brand_watermark_image: brandWatermarkUrl,
            onlyWatermarkedInApi: !imageUrl && !!(watermarkUrl || aiWatermarkUrl || brandWatermarkUrl),
            allFieldsSameUrl: uniqueKeys.size <= 1 && keys.length > 0,
        };
    }

    function logParsedImageBatch(items) {
        if (!items.length || !DEBUG) {
            return;
        }

        console.groupCollapsed(`[千问无水印] 接口图片 URL（${items.length} 条 display）`);
        items.forEach((item, index) => {
            debugLog(`#${index + 1}`, item);
            if (item.onlyWatermarkedInApi) {
                debugWarn(`#${index + 1} 接口未返回 image 原图字段，仅有 watermark 字段`);
            } else if (item.allFieldsSameUrl) {
                debugWarn(`#${index + 1} image 与 watermark 字段 URL 相同，服务端可能已不再单独下发无水印地址`);
            }
        });
        console.groupEnd();
    }

    function collectUrlsFromDisplay(display, debugBatch) {
        if (!display || display.type === 'ref_image') {
            return 0;
        }

        const summary = summarizeDisplayUrls(display);
        if (debugBatch) {
            debugBatch.push(summary);
        }

        const cleanUrl = pickUrl(display.image);
        if (!cleanUrl) {
            return 0;
        }

        rememberApiOriginalUrl(cleanUrl);

        let added = 0;
        if (registerUrlPair(cleanUrl, cleanUrl)) {
            added += 1;
        }

        [
            display.watermark_image,
            display.ai_watermark_image,
            display.brand_watermark_image,
        ].forEach((item) => {
            const displayUrl = pickUrl(item);
            if (displayUrl && registerUrlPair(displayUrl, cleanUrl)) {
                added += 1;
            }
        });

        return added;
    }

    function collectUrlsFromNode(node, depth, seen, debugBatch) {
        if (!node || typeof node !== 'object') {
            return 0;
        }
        if (seen.has(node)) {
            return 0;
        }
        seen.add(node);

        let added = 0;

        if (Array.isArray(node.display_list)) {
            node.display_list.forEach((display) => {
                added += collectUrlsFromDisplay(display, debugBatch);
            });
        }

        if (node.cardMap && typeof node.cardMap === 'object') {
            Object.values(node.cardMap).forEach((card) => {
                added += collectUrlsFromNode(card?.content, depth + 1, seen, debugBatch);
            });
        }

        if (Array.isArray(node.multi_load)) {
            node.multi_load.forEach((item) => {
                added += collectUrlsFromNode(item?.content, depth + 1, seen, debugBatch);
            });
        }

        if (depth < 12) {
            if (Array.isArray(node)) {
                node.forEach((item) => {
                    added += collectUrlsFromNode(item, depth + 1, seen, debugBatch);
                });
            } else {
                Object.values(node).forEach((value) => {
                    added += collectUrlsFromNode(value, depth + 1, seen, debugBatch);
                });
            }
        }

        return added;
    }

    function ingestPayload(data) {
        const debugBatch = [];
        const added = collectUrlsFromNode(data, 0, new WeakSet(), debugBatch);
        if (added > 0 && urlToCleanUrl.size !== loggedMapSize) {
            loggedMapSize = urlToCleanUrl.size;
            debugLog(`[千问无水印] 已建立 ${urlToCleanUrl.size} 条映射：页面水印图 URL → 接口 image 原图`);
            logParsedImageBatch(debugBatch);
            scheduleScan();
        }
        return added;
    }

    function parseResponseText(text) {
        if (!text || typeof text !== 'string') {
            return;
        }
        const trimmed = text.trim();
        if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
            return;
        }
        try {
            ingestPayload(JSON.parse(trimmed));
        } catch {
            // ignore non-json payloads
        }
    }

    function observeSnapStream(response) {
        if (!response.body) {
            return;
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let waitingForData = false;

        const pump = () => {
            reader.read().then(({ done, value }) => {
                if (done) {
                    return;
                }

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    if (line.trimEnd() === 'event:complete') {
                        waitingForData = true;
                        continue;
                    }
                    if (waitingForData && line.startsWith('data:')) {
                        waitingForData = false;
                        parseResponseText(line.slice(5).trim());
                        continue;
                    }
                    if (line.trim() === '') {
                        waitingForData = false;
                    }
                }

                pump();
            }).catch(() => {});
        };

        pump();
    }

    function handleNetworkResponse(url, response) {
        if (!shouldIngestRequest(url)) {
            return;
        }

        if (url.includes('/api/v1/chat/snap')) {
            observeSnapStream(response.clone());
            return;
        }

        response.clone().text().then(parseResponseText).catch(() => {});
    }

    function installNetworkHook() {
        if (hookInstalled) {
            return;
        }
        hookInstalled = true;

        const originalFetch = nativeFetch;
        window.fetch = async function(...args) {
            const response = await originalFetch.apply(this, args);
            const requestUrl = typeof args[0] === 'string'
                ? args[0]
                : args[0]?.url || '';

            handleNetworkResponse(requestUrl, response);
            return response;
        };

        const originalOpen = XMLHttpRequest.prototype.open;
        const originalSend = XMLHttpRequest.prototype.send;

        XMLHttpRequest.prototype.open = function(method, url, ...rest) {
            this.__qwenRequestUrl = typeof url === 'string' ? url : String(url);
            return originalOpen.call(this, method, url, ...rest);
        };

        XMLHttpRequest.prototype.send = function(...args) {
            this.addEventListener('load', function() {
                const url = this.__qwenRequestUrl || '';
                if (!shouldIngestRequest(url)) {
                    return;
                }
                parseResponseText(this.responseText);
            });
            return originalSend.apply(this, args);
        };

        debugLog('[千问无水印] 网络监听已启动');
    }

    function blobFromCanvasImage(img) {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext('2d').drawImage(img, 0, 0);
        return new Promise((resolve, reject) => {
            canvas.toBlob((blob) => {
                if (blob) {
                    resolve(blob);
                    return;
                }
                reject(new Error('canvas toBlob failed'));
            }, 'image/png');
        });
    }

    function requestBlobViaCrossOriginImage(url) {
        return new Promise((resolve, reject) => {
            const img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => {
                blobFromCanvasImage(img).then(resolve).catch(reject);
            };
            img.onerror = () => reject(new Error('crossOrigin image load failed'));
            img.src = url;
        });
    }

    function requestBlobFromVisibleImage(sourceEl, url) {
        if (!(sourceEl instanceof HTMLImageElement)) {
            return Promise.reject(new Error('not an img element'));
        }
        if (normalizeUrlKey(sourceEl.currentSrc || sourceEl.src) !== normalizeUrlKey(url)) {
            return Promise.reject(new Error('visible image url mismatch'));
        }
        if (!sourceEl.complete || !sourceEl.naturalWidth) {
            return Promise.reject(new Error('visible image not ready'));
        }
        return blobFromCanvasImage(sourceEl);
    }

    function triggerBlobDownload(blob, fileName) {
        const blobUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');

        link.href = blobUrl;
        link.download = fileName;
        link.style.display = 'none';

        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(blobUrl);
    }

    function requestBlobViaXHR(url) {
        return new Promise((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('GET', url, true);
            xhr.responseType = 'blob';
            xhr.withCredentials = true;
            xhr.onload = function() {
                if (this.status >= 200 && this.status < 300) {
                    resolve(this.response);
                    return;
                }
                reject(new Error(`HTTP ${this.status}`));
            };
            xhr.onerror = function() {
                reject(new Error('XHR network error'));
            };
            xhr.send();
        });
    }

    async function downloadImage(url, sourceElement) {
        const normalizedUrl = normalizeProtocol(url);
        if (!normalizedUrl) {
            alert('无效的图片地址');
            return;
        }

        const fileName = `image_${Date.now()}.png`;
        const attempts = buildDownloadAttempts(normalizedUrl, sourceElement);
        let lastError = null;

        for (let i = 0; i < attempts.length; i += 1) {
            try {
                const blob = await attempts[i]();
                triggerBlobDownload(blob, fileName);
                return;
            } catch (error) {
                lastError = error;
            }
        }

        console.error('[千问无水印] 下载失败:', lastError);
        alert('无法直接保存文件（可能被跨域或广告拦截拦截）。请用千问自带下载按钮，或右键图片另存为。');
    }

    function findButtonPlacement(imgLike) {
        if (imgLike instanceof HTMLImageElement) {
            const next = imgLike.nextElementSibling;
            if (next && next.tagName === 'DIV') {
                return {
                    container: next,
                    mode: 'toolbar',
                    hoverTarget: imgLike.closest('[class*="group"], [class*="image"], [class*="card"]')
                        || imgLike.parentElement,
                };
            }
        }

        const parent = imgLike.parentElement;
        if (!parent) {
            return null;
        }

        if (getComputedStyle(parent).position === 'static') {
            parent.style.position = 'relative';
        }

        return {
            container: parent,
            mode: 'overlay-left',
            hoverTarget: parent,
        };
    }

    function applyDownloadButtonStyles(downloadLink, mode) {
        const base = `
            color:#1890ff;
            text-decoration:none;
            font-size:14px;
            line-height:1;
            cursor:pointer;
            z-index:5;
            box-sizing:border-box;
        `;

        if (mode === 'toolbar') {
            downloadLink.style.cssText = `${base}
                display:inline-flex;
                align-items:center;
                justify-content:center;
                width:28px;
                height:28px;
                margin:0 0 0 8px;
                padding:0;
                vertical-align:middle;
            `;
            return;
        }

        downloadLink.style.cssText = `${base}
            position:absolute;
            bottom:12px;
            left:12px;
            top:auto;
            right:auto;
            display:none;
            background:rgba(255,255,255,0.92);
            border-radius:6px;
            padding:4px 8px;
            margin:0;
        `;
    }

    function bindDownloadButton(element, placement, getUrl) {
        let downloadLink = elementButtons.get(element);

        if (!downloadLink) {
            const clickState = { getUrl };
            const { container, mode, hoverTarget } = placement;

            downloadLink = document.createElement('a');
            downloadLink.href = '#';
            downloadLink.className = 'qwen-no-watermark-btn';
            downloadLink.textContent = '⬇️';
            downloadLink.title = '下载无水印原图';
            applyDownloadButtonStyles(downloadLink, mode);

            if (mode === 'overlay-left' && hoverTarget) {
                hoverTarget.addEventListener('mouseenter', () => {
                    downloadLink.style.display = 'inline-block';
                });
                hoverTarget.addEventListener('mouseleave', () => {
                    downloadLink.style.display = 'none';
                });
            }

            downloadLink.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const url = clickState.getUrl();
                debugLog('[千问无水印] 下载接口 image 原图:', url);
                downloadImage(url, element);
            });

            if (mode === 'toolbar') {
                container.appendChild(downloadLink);
            } else {
                container.appendChild(downloadLink);
            }

            downloadLink.__qwenClickState = clickState;
            elementButtons.set(element, downloadLink);

            if (!loggedReady) {
                loggedReady = true;
                debugLog('[千问无水印] 已启用，悬停 AI 生图可下载无水印原图');
            }
        }

        downloadLink.__qwenClickState.getUrl = getUrl;
    }

    function processImage(img) {
        if (!isGeneratedChatImage(img)) {
            return;
        }

        const placement = findButtonPlacement(img);
        if (!placement || placement.container.querySelector('.qwen-no-watermark-btn')) {
            return;
        }

        bindDownloadButton(img, placement, () => resolveDownloadUrl(img, img.currentSrc || img.src));
    }

    function processBackgroundElement(element) {
        if (!isGeneratedBackgroundElement(element)) {
            return;
        }

        const imageUrl = getBackgroundImageUrl(element);
        const placement = findButtonPlacement(element);
        if (!placement || placement.container.querySelector('.qwen-no-watermark-btn')) {
            return;
        }

        bindDownloadButton(element, placement, () => resolveDownloadUrl(element, imageUrl));
    }

    function scanImages() {
        document.querySelectorAll('img').forEach(processImage);
        document.querySelectorAll('[data-image-context]').forEach(processBackgroundElement);
    }

    let scanTimer = null;
    function scheduleScan() {
        clearTimeout(scanTimer);
        scanTimer = setTimeout(scanImages, 200);
    }

    function initObserver() {
        scanImages();

        const observer = new MutationObserver(() => {
            scheduleScan();
        });

        observer.observe(document.body, {
            childList: true,
            subtree: true,
        });
    }

    installNetworkHook();

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initObserver, { once: true });
    } else {
        initObserver();
    }
})();
