#!/usr/bin/env node
/**
 * manta-action-kit 套件健康检查。
 *
 * 用法：node check-env.mjs
 * 退出码：0 = 全部通过；1 = 有问题（每项前缀 ✅/❌/⚠️ 并给出修复建议）。
 *
 * 检查项：
 *   1. packages/mcp/dist/index.js 已构建
 *   2. Claude Code 已注册 manta-action-kit MCP server
 *   3. WS 桥端口（默认 8787）有 MCP server 进程在听
 *   4. 端到端探活：以 peer 身份连入桥，转发 list_recordings 到扩展
 *      —— 能区分「桥在但扩展没连」与「全链路通」
 *
 * 需要 Node >= 22（使用原生 WebSocket）。端口可用 MANTA_WS_PORT / MANTA_PROXY_PORT 覆盖。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const MCP_PORT = Number(process.env.MANTA_WS_PORT) || 8787;
const PROXY_PORT = Number(process.env.MANTA_PROXY_PORT) || 8788;

const results = [];
const report = (ok, label, detail = '') => {
  const mark = ok === 'skip' ? '⚠️' : ok ? '✅' : '❌';
  results.push(ok === true);
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`);
};

// ── 1. dist 已构建 ────────────────────────────────────────────────────────────
const distEntry = path.join(ROOT, 'packages/mcp/dist/index.js');
if (existsSync(distEntry)) {
  report(true, 'MCP 产物已构建 (packages/mcp/dist/index.js)');
} else {
  report(false, 'MCP 产物缺失', '运行 pnpm build:mcp');
}

// ── 2. Claude Code 注册状态 ───────────────────────────────────────────────────
const claude = spawnSync('claude', ['mcp', 'list'], { encoding: 'utf8', timeout: 30_000 });
if (claude.error) {
  report('skip', 'claude CLI 不可用，跳过注册检查');
} else {
  const line = (claude.stdout + claude.stderr)
    .split('\n')
    .find((l) => l.includes('manta-action-kit'));
  if (line && line.includes('✔')) {
    report(true, 'Claude Code 已注册 manta-action-kit MCP');
  } else if (line) {
    report(false, `已注册但未连上: ${line.trim()}`, '先跑 pnpm build:mcp，再 /mcp reconnect');
  } else {
    report(
      false,
      'Claude Code 未注册 manta-action-kit MCP',
      `运行 claude mcp add manta-action-kit --scope local -- node ${distEntry}`,
    );
  }
}

// ── 3+4. WS 桥 + 端到端探活 ──────────────────────────────────────────────────
if (typeof WebSocket === 'undefined') {
  report('skip', `Node ${process.version} 无原生 WebSocket，跳过连接检查（需 Node >= 22）`);
} else {
  const exitCode = await probeBridge();
  process.exitCode = exitCode;
}

/** 连 ws://127.0.0.1:<MCP_PORT>，以 peer 身份探活扩展。返回退出码。 */
async function probeBridge() {
  let ws;
  try {
    ws = await new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${MCP_PORT}`);
      const onOpen = () => {
        cleanup();
        resolve(socket);
      };
      const onError = (err) => {
        cleanup();
        reject(err?.error ?? err);
      };
      const t = setTimeout(() => {
        cleanup();
        socket.close();
        reject(new Error('connect timeout'));
      }, 5_000);
      const cleanup = () => {
        clearTimeout(t);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
      };
      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
    });
  } catch {
    report(false, `WS 桥端口 ${MCP_PORT} 无进程监听`, 'MCP server 未运行（MCP 客户端会话未启动？），或端口被改');
    return 1;
  }
  report(true, `WS 桥端口 ${MCP_PORT} 有 MCP server 在听`);

  try {
    const result = await rpc(ws, 'list_recordings', {}, 10_000);
    const count = Array.isArray(result) ? result.length : (result?.recordings?.length ?? '未知');
    report(true, '端到端探活通过（MCP → 桥 → 扩展）', `当前录制数: ${count}`);
    return 0;
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (msg.includes('No Chrome extension connected')) {
      report(false, '桥在但扩展未连入', '确认 Chrome 已开且加载扩展；侧边栏设置里「MCP 服务」开关已打开；端口与 server 一致');
    } else if (msg.includes('timed out')) {
      report(false, '扩展连着但无响应', '扩展刚刷新或 service worker 休眠，唤醒扩展侧边栏后重试');
    } else {
      report(false, '端到端探活失败', msg);
    }
    return 1;
  } finally {
    ws.close();
  }
}

/** 发 hello(peer) + peer-rpc，等待对应 id 的 peer-rpc-result。 */
function rpc(ws, method, params, timeoutMs) {
  return new Promise((resolve, reject) => {
    const id = `check-${Date.now()}`;
    const timer = setTimeout(() => reject(new Error(`peer RPC "${method}" timed out after ${timeoutMs}ms`)), timeoutMs);
    ws.addEventListener('message', (ev) => {
      let frame;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (frame.type === 'peer-rpc-result' && frame.id === id) {
        clearTimeout(timer);
        frame.ok ? resolve(frame.result) : reject(new Error(frame.error));
      }
    });
    ws.send(JSON.stringify({ type: 'hello', role: 'peer', version: '0.0.0' }));
    ws.send(JSON.stringify({ type: 'peer-rpc', id, method, params }));
  });
}
