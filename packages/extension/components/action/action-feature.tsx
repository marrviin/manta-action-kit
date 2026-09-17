import { useEffect, useState } from "react";
import {
  App,
  Button,
  Dropdown,
  Empty,
  Input,
  Spin,
  Tag,
  Typography,
} from "antd";
import { DeleteOutlined, SearchOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { deleteAction, listActions } from "@/lib/db";
import { UnifiedListItem } from "@/components/common/unified-list-item";
import type { Action, ActionStep } from "@/lib/action/types";

const { Text } = Typography;

/**
 * "Actions" side-panel feature. Lists agent-authored replayable actions stored in
 * the IndexedDB `actions` store (v10). Actions are created by agents via MCP
 * (create_action, confirmed by the native permission prompt); here the user
 * browses, inspects (description / params / steps) and deletes them. Execution
 * deliberately goes through the execute_action MCP tool — gated by its own
 * permission prompt — never directly from this list.
 */
export function ActionFeature() {
  const { t } = useTranslation();
  const [actions, setActions] = useState<Action[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [search, setSearch] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const refresh = () => {
    setError(null);
    listActions()
      .then(setActions)
      .catch((e) => setError(e instanceof Error ? e : new Error(String(e))));
  };

  useEffect(() => {
    refresh();
  }, []);

  const remove = async (id: string) => {
    await deleteAction(id);
    setActions((prev) => prev?.filter((a) => a.id !== id) ?? null);
  };

  const query = search.trim().toLowerCase();
  const filtered =
    actions === null
      ? []
      : query
        ? actions.filter(
            (a) =>
              a.name.toLowerCase().includes(query) ||
              a.description.toLowerCase().includes(query),
          )
        : actions;

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span>
              {t("action.loadFailed")}
              <br />
              <Text type="secondary" className="text-xs">
                {error.message}
              </Text>
            </span>
          }
        >
          <Button size="small" onClick={refresh}>
            {t("common.retry")}
          </Button>
        </Empty>
      </div>
    );
  }

  if (actions === null) {
    return (
      <div className="p-8 text-center">
        <Spin />
      </div>
    );
  }

  if (actions.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={false} />
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <div className="p-2">
        <Input
          allowClear
          prefix={<SearchOutlined />}
          placeholder={t("action.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {filtered.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t("action.noMatch")}
            />
          </div>
        ) : (
          filtered.map((action) => (
            <ActionRow
              key={action.id}
              action={action}
              expanded={expandedId === action.id}
              onToggle={() =>
                setExpandedId(expandedId === action.id ? null : action.id)
              }
              onRemove={() => remove(action.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function ActionRow({
  action,
  expanded,
  onToggle,
  onRemove,
}: {
  action: Action;
  expanded: boolean;
  onToggle: () => void;
  onRemove: () => void;
}) {
  const { modal } = App.useApp();
  const { t } = useTranslation();

  const confirmDelete = () => {
    modal.confirm({
      title: t("action.deleteTitle"),
      content: t("action.deleteConfirm", { name: action.name }),
      okText: t("common.delete"),
      okButtonProps: { danger: true },
      cancelText: t("common.cancel"),
      onOk: onRemove,
      centered: true,
    });
  };

  return (
    <Dropdown
      trigger={["contextMenu"]}
      menu={{
        items: [
          {
            key: "delete",
            label: t("common.delete"),
            danger: true,
            onClick: confirmDelete,
          },
        ],
      }}
    >
      <div>
        <UnifiedListItem
          className="manta-action-kit-action-item"
          clickable
          onClick={onToggle}
          expandable
          expanded={expanded}
          onToggleExpand={onToggle}
          title={
            <Text ellipsis className="text-sm">
              {action.name}
            </Text>
          }
          actions={
            <Button
              key="delete"
              type="text"
              size="small"
              icon={<DeleteOutlined />}
              onClick={(e) => {
                e.stopPropagation();
                confirmDelete();
              }}
            />
          }
          status={
            <>
              <Tag color="blue" className="me-0 text-xs rounded">
                {t("action.stepCount", { count: action.steps.length })}
              </Tag>
              <Tag
                color={action.params.length > 0 ? "geekblue" : "default"}
                className="me-0 text-xs rounded"
              >
                {action.params.length > 0
                  ? t("action.paramCount", { count: action.params.length })
                  : t("action.noParams")}
              </Tag>
            </>
          }
          timestamp={action.createdAt}
          detail={<ActionDetail action={action} />}
        />
      </div>
    </Dropdown>
  );
}

/** Expanded panel under a row: description, declared params, and the step list. */
function ActionDetail({ action }: { action: Action }) {
  const { t } = useTranslation();

  return (
    <div className="text-xs leading-relaxed">
      <Text type="secondary" className="whitespace-pre-wrap">
        {action.description}
      </Text>

      {action.params.length > 0 && (
        <div className="mt-2">
          <Text strong className="text-xs">
            {t("action.paramsLabel")}
          </Text>
          <div className="mt-1 flex flex-col gap-0.5">
            {action.params.map((p) => (
              <div key={p.name} className="flex items-baseline gap-1.5">
                <Text className="font-mono">{p.name}</Text>
                <Tag className="me-0 text-xs rounded">{p.type}</Tag>
                {!p.required && (
                  <Text type="secondary" className="text-xs">
                    {t("action.paramOptional")}
                  </Text>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="mt-2">
        <Text strong className="text-xs">
          {t("action.stepsLabel")}
        </Text>
        <div className="mt-1 flex flex-col gap-0.5">
          {action.steps.map((step, i) => (
            <StepLine key={i} index={i + 1} step={step} />
          ))}
        </div>
      </div>
    </div>
  );
}

function StepLine({ index, step }: { index: number; step: ActionStep }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-baseline gap-1.5 flex-wrap">
      <Text type="secondary" className="font-mono">
        #{index}
      </Text>
      <Tag
        color={step.kind === "sse" ? "purple" : "cyan"}
        className="me-0 text-xs rounded"
      >
        {step.kind}
      </Tag>
      {step.overrides && step.overrides.length > 0 && (
        <Text type="secondary" className="text-xs">
          {t("action.stepOverrides", { count: step.overrides.length })}
        </Text>
      )}
      {step.waitMs && step.waitMs > 0 && (
        <Text type="secondary" className="text-xs">
          {t("action.stepWait", { ms: step.waitMs })}
        </Text>
      )}
    </div>
  );
}
