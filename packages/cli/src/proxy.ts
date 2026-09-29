/**
 * HTTP 代理工具。
 *
 * 自动读取 HTTP_PROXY / HTTPS_PROXY / http_proxy 环境变量，
 * 通过 undici setGlobalDispatcher 设置全局代理，对所有 fetch 请求生效。
 */

import { ProxyAgent, setGlobalDispatcher } from 'undici';

/** 从环境变量解析代理 URL。 优先级：HTTPS_PROXY > HTTP_PROXY > http_proxy */
function resolveProxyUrl(): string | undefined {
  return process.env.HTTPS_PROXY
    || process.env.HTTP_PROXY
    || process.env.http_proxy
    || undefined;
}

/** 设置 undici 全局代理。应在应用启动时调用一次。 */
export function setupGlobalProxy(): void {
  const proxyUrl = resolveProxyUrl();
  if (proxyUrl) {
    setGlobalDispatcher(new ProxyAgent({ uri: proxyUrl, requestTls: { rejectUnauthorized: true } }));
  }
}
