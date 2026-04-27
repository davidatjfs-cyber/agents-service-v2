/**
 * MCP Client — 通过 Tailscale 连接到本地 agent-reach MCP 服务器
 *
 * 使用 MCP Streamable HTTP 协议（JSON-RPC 2.0），
 * 通过 fetch 直接调用，无需额外 SDK。
 *
 * 用法:
 *   import { callTool, listTools, checkMcpHealth } from './mcp-client.js';
 *   const result = await callTool('web_search', { query: '...' });
 */

import { logger } from '../utils/logger.js';

const MCP_SERVER_URL = process.env.AGENT_REACH_MCP_URL || 'http://100.66.169.37:3102/mcp';
const AUTH_TOKEN = process.env.AGENT_REACH_AUTH_TOKEN || '';
const REQUEST_TIMEOUT_MS = parseInt(process.env.AGENT_REACH_TIMEOUT || '45000', 10);
const MAX_RETRIES = 2;

let _toolsCache = null;
let _toolsCacheTime = 0;
const TOOLS_CACHE_TTL = 300000; // 5 分钟

/**
 * 使用 MCP Streamable HTTP 协议发送 JSON-RPC 请求
 */
async function mcpRequest(method, params = {}) {
  const body = { jsonrpc: '2.0', id: `req-${Date.now()}`, method, params };
  const headers = { 'Content-Type': 'application/json' };
  if (AUTH_TOKEN) headers['Authorization'] = `Bearer ${AUTH_TOKEN}`;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

      const response = await fetch(MCP_SERVER_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`MCP server HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(`MCP error: ${data.error.message} (code ${data.error.code})`);
      }

      return data.result;
    } catch (e) {
      const isLast = attempt >= MAX_RETRIES;
      logger.warn(
        { attempt, max: MAX_RETRIES, err: e?.message, method },
        `MCP request failed${isLast ? ', giving up' : ', retrying'}`
      );
      if (isLast) throw e;
      // 简单指数退避
      await new Promise(r => setTimeout(r, 500 * attempt));
    }
  }
}

/**
 * 列出本地 MCP 服务器上的所有可用工具
 * 结果缓存 5 分钟
 */
export async function listTools() {
  const now = Date.now();
  if (_toolsCache && now - _toolsCacheTime < TOOLS_CACHE_TTL) {
    return _toolsCache;
  }
  const result = await mcpRequest('tools/list');
  _toolsCache = result.tools || [];
  _toolsCacheTime = now;
  return _toolsCache;
}

/**
 * 调用本地 MCP 服务器上的工具
 *
 * @param {string} name  - 工具名称（web_search / read_url / github_search 等）
 * @param {object} args  - 工具参数
 * @returns {Promise<string>} 工具输出文本
 */
export async function callTool(name, args = {}) {
  const result = await mcpRequest('tools/call', { name, arguments: args });

  if (result?.content && Array.isArray(result.content)) {
    return result.content
      .filter(c => c.type === 'text')
      .map(c => c.text)
      .join('\n');
  }
  return String(result || '');
}

/**
 * 检查与 MCP 服务器的连接状态
 */
export async function checkMcpHealth() {
  try {
    const url = MCP_SERVER_URL.replace('/mcp', '/health');
    const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return r.ok ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
  } catch (e) {
    return { ok: false, error: e?.message || 'connection_failed' };
  }
}
