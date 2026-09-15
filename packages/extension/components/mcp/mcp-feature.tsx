import { useEffect, useState } from 'react';
import { App, Alert, Badge, Button, Divider, Switch, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { settings, type McpConnStatus } from '@/lib/storage';
import { buildInstallPrompt } from '@/lib/mcp/install-prompt';
import {
  TOOL_REGISTRY,
  isToolEnabled,
  isOpsTool,
  toolLabelKey,
  toolDescKey,
  type RpcMethod,
} from '@/lib/mcp/protocol';
import { useMcpConnStatus } from '@/hooks/use-mcp-conn-status';

const { Text } = Typography;

/** Map a connection status to the antd Badge status + i18n label key shown in the header. */
const CONN_META = {
  connected: { status: 'success', labelKey: 'mcp.connected' },
  connecting: { status: 'processing', labelKey: 'mcp.connecting' },
  disconnected: { status: 'default', labelKey: 'mcp.disconnected' },
} as const satisfies Record<
  McpConnStatus,
  { status: 'success' | 'processing' | 'default'; labelKey: string }
>;

/**
 * "MCP" side-panel feature. The MCP control panel:
 *   - 复制安装提示词
 *   - 连接状态（只读，background 常驻连接本地 MCP 服务）+ 端口
 *   - 对外工具的逐项开关（默认全开）
 * Self-contained; mounts inside the home tab. There is no MCP master switch — the
 * bridge always connects; per-call native prompts + per-tool switches are the gate.
 */
export function McpFeature() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const connStatus = useMcpConnStatus();
  const [mcpPort, setMcpPort] = useState(8787);
  const [proxyPort, setProxyPort] = useState(8788);
  const [toolMap, setToolMap] = useState<Partial<Record<RpcMethod, boolean>>>({});

  useEffect(() => {
    settings.mcpPort.getValue().then(setMcpPort);
    settings.proxyPort.getValue().then(setProxyPort);
    settings.mcpToolEnabled.getValue().then(setToolMap);
    const u2 = settings.mcpPort.watch((v) => setMcpPort(v ?? 8787));
    const u4 = settings.proxyPort.watch((v) => setProxyPort(v ?? 8788));
    const u3 = settings.mcpToolEnabled.watch((v) => setToolMap(v ?? {}));
    return () => {
      u2();
      u3();
      u4();
    };
  }, []);

  /** Flip one tool's kill switch. Stored as {method: false} only when disabled. */
  const toggleTool = async (method: RpcMethod, enabled: boolean) => {
    const next = { ...toolMap };
    if (enabled) delete next[method];
    else next[method] = false;
    setToolMap(next);
    await settings.mcpToolEnabled.setValue(next);
  };

  const copyInstallPrompt = async () => {
    try {
      await navigator.clipboard.writeText(buildInstallPrompt(mcpPort, proxyPort));
      message.success(t('mcp.installPromptCopied'));
    } catch {
      message.error(t('common.copyFailed'));
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-auto pt-2 px-3 pb-4">
      {/* 描述说明 + 复制安装提示词 */}
      <Alert
        type="info"
        className="mt-3"
        message={
          <div>
            <div className="font-medium mb-1">{t('mcp.introTitle')}</div>
            <div className="text-xs leading-relaxed">{t('mcp.introDesc')}</div>
            <ul className="text-xs leading-relaxed my-1 pl-4 list-disc">
              <li>{t('mcp.introBullet1')}</li>
              <li>{t('mcp.introBullet2')}</li>
            </ul>
            <div className="text-xs leading-relaxed">{t('mcp.introFooter')}</div>
            <Button block onClick={copyInstallPrompt} className="mt-4">
              {t('mcp.copyInstallPrompt')}
            </Button>
          </div>
        }
      />

      <Divider className="my-4" />

      {/* 配置项 */}
      <div className="flex items-center justify-between mt-4">
        <div>
          <Text strong>{t('mcp.status')}</Text>
        </div>
        <Badge status={CONN_META[connStatus].status} text={t(CONN_META[connStatus].labelKey)} />
      </div>
      {/* 端口只读展示:主端口为约定固定值,代理端口会随 MCP 服务自愈(set_proxy_port)漂移并回填,
          这里始终展示当前实际连接端口,不提供手动修改。 */}
      <div className="flex items-center justify-between mt-3">
        <Text type="secondary" className="text-sm">
          {t('mcp.port')}
        </Text>
        <Text className="text-sm font-mono">{mcpPort}</Text>
      </div>
      <div className="flex items-center justify-between mt-3">
        <Text type="secondary" className="text-sm">
          {t('mcp.proxyPort')}
        </Text>
        <Text className="text-sm font-mono">{proxyPort}</Text>
      </div>

      <Divider className="my-4" />

      {/* 工具开关:默认全开,可单独关闭某个工具 */}
      <div className="mt-4">
        <Text strong>{t('mcp.tools')}</Text>
      </div>
      <div className="mt-3 flex flex-col gap-3">
        {TOOL_REGISTRY.map((tool) => {
          const ops = isOpsTool(tool.group);
          // Ops tools run inside the MCP process; the extension-side kill switch
          // can't reach them, so show the switch as on-but-disabled.
          const enabled = ops ? true : isToolEnabled(toolMap, tool.method as RpcMethod);
          const label = t(toolLabelKey(tool.method));
          return (
            <div key={tool.method} className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <Text className="text-sm">{label}</Text>
                </div>
                <div>
                  <Text type="secondary" className="text-xs">
                    {t(toolDescKey(tool.method))}
                  </Text>
                </div>
              </div>
              <Switch
                size="small"
                checked={enabled}
                disabled={ops}
                onChange={async (v) => {
                  await toggleTool(tool.method as RpcMethod, v);
                  message.success(
                    v ? t('mcp.toolEnabled', { label }) : t('mcp.toolDisabled', { label }),
                  );
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
