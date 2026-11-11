'use strict';
// Browser tooling is optional; prefer a contributor's local Playwright installation.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let playwright;
if (process.env.PLAYWRIGHT_MODULE) {
  playwright = require(process.env.PLAYWRIGHT_MODULE);
} else {
  let modulePath;
  try { modulePath = require.resolve('playwright'); }
  catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') throw error;
    const bundled = path.join(os.homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright');
    if (fs.existsSync(bundled)) modulePath = bundled;
    else throw new Error('浏览器测试需要可选 Playwright；请先执行 README 中的测试工具安装步骤，或设置 PLAYWRIGHT_MODULE。');
  }
  playwright = require(modulePath);
}

const { chromium } = playwright;
const candidates = process.env.BROWSER_EXECUTABLE ? [process.env.BROWSER_EXECUTABLE] : [
  chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
];
const executablePath = candidates.find(candidate => fs.existsSync(candidate));
if (!executablePath) throw new Error('找不到浏览器；请安装 Playwright Chromium 或设置有效的 BROWSER_EXECUTABLE。');

module.exports = { chromium, executablePath };
