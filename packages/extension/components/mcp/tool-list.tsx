import { useEffect, useState } from 'react';
import { App, Switch, Typography } from 'antd';
import { useTranslation } from 'react-i18next';
import { settings } from '@/lib/storage';
import {
  TOOL_REGISTRY,
  isToolEnabled,
  isOpsTool,
  toolLabelKey,
  toolDescKey,
  type RpcMethod,
} from '@/lib/mcp/protocol';

const { Text } = Typography;

/**
 * The MCP tool kill-switch list, shown in the settings page's connector card
 * (settings-feature.tsx). One row per
 * registered tool: label + description + Switch. All tools are on by default;
 * ops tools run inside the MCP process so their switch is on-but-disabled.
 */
export function McpToolList() {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const [toolMap, setToolMap] = useState<Partial<Record<RpcMethod, boolean>>>({});

  useEffect(() => {
    settings.mcpToolEnabled.getValue().then(setToolMap);
    const unwatch = settings.mcpToolEnabled.watch((v) => setToolMap(v ?? {}));
    return () => unwatch();
  }, []);

  /** Flip one tool's kill switch. Stored as {method: false} only when disabled. */
  const toggleTool = async (method: RpcMethod, enabled: boolean) => {
    const next = { ...toolMap };
    if (enabled) delete next[method];
    else next[method] = false;
    setToolMap(next);
    await settings.mcpToolEnabled.setValue(next);
  };

  return (
    <div className="flex flex-col gap-3">
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
  );
}
