// ==UserScript==
// @name         千问无水印图片下载
// @namespace    https://github.com/chushijack/qwen-no-watermark
// @version      1.0.1
// @description  千问AI生图下载没有水印的原图
// @author       ChushiJack
// @license      GPL-3.0
// @csdnURL      https://blog.csdn.net/2301_77607029
// @homepageURL  https://github.com/chushijack/qwen-no-watermark
// @supportURL   https://github.com/chushijack/qwen-no-watermark/issues
// @downloadURL  https://raw.githubusercontent.com/chushijack/qwen-no-watermark/main/qwen-no-watermark.js
// @updateURL    https://raw.githubusercontent.com/chushijack/qwen-no-watermark/main/qwen-no-watermark.js
// @match        https://www.qianwen.com/chat/*
// @icon         https://img.alicdn.com/imgextra/i2/O1CN01taBbMS1CfyJoOt0lB_!!6000000000109-2-tps-80-80.png
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    /**
     * 图片选择器
     */
    const IMG_SELECTOR = 'img[data-image-watermark-url]';

    /**
     * 下载图片
     * @param {string} url 图片地址
     */
    async function downloadImage(url) {
        try {
            // 请求图片资源
            const response = await fetch(url, {
                mode: 'cors',
            });

            const blob = await response.blob();

            const blobUrl = URL.createObjectURL(blob);

            const link = document.createElement('a');

            link.href = blobUrl;
            link.download = `image_${Date.now()}.jpg`;
            link.style.display = 'none';

            document.body.appendChild(link);

            link.click();

            document.body.removeChild(link);

            URL.revokeObjectURL(blobUrl);

        } catch (error) {
            console.error('图片下载失败:', error);
            alert('图片跨域无法下载');
        }
    }

    /**
     * 创建下载按钮
     * @param {HTMLImageElement} img 图片元素
     */
    function createDownloadButton(img) {

        const src = img.src;

        const targetDiv = img.nextElementSibling;

        if (!targetDiv || targetDiv.tagName !== 'DIV') {
            return;
        }

        const downloadLink = document.createElement('a');

        downloadLink.href = '#';

        downloadLink.textContent = '⬇️';

        downloadLink.title = '下载无水印图片';

        downloadLink.style.cssText = `
            color:#1890ff;
            text-decoration:none;
            font-size:14px;
            cursor:pointer;
            margin-left:5px;
        `;

        /**
         * 点击下载
         */
        downloadLink.addEventListener('click', function(event) {

            event.preventDefault();

            downloadImage(src);

        });

        targetDiv.appendChild(downloadLink);
    }

    /**
     * 处理单个图片
     * @param {HTMLImageElement} img
     */
    function processImage(img) {

        if (img.dataset.processed) {
            return;
        }

        const src = img.src;

        img.setAttribute('data-image-watermark-url', src);

        console.log('✅ 已成功开启去除图片水印，可下载无水印原图')

        createDownloadButton(img);

        img.dataset.processed = 'true';
    }

    /**
     * 查找页面所有目标图片
     */
    function findAllImg() {

        const imgList = document.querySelectorAll(IMG_SELECTOR);

        imgList.forEach(img => {
            processImage(img);
        });
    }

    /**
     * 初始化监听
     */
    function initObserver() {

        findAllImg();

        /**
         * DOM变化监听
         */
        const observer = new MutationObserver(() => {

            clearTimeout(observer.timer);

            observer.timer = setTimeout(() => {

                findAllImg();

            }, 300);

        });

        observer.observe(document.body, {
            childList: true, subtree: true,
        });
    }

    /**
     * 程序入口
     */
    initObserver();

})();