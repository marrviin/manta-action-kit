import { useEffect, useMemo, useRef, useState } from "react";
import {
  App,
  Button,
  Empty,
  Input,
  Spin,
  Tag,
  Typography,
} from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useRecordings } from "@/hooks/use-recordings";
import { getCalls } from "@/lib/db";
import { UnifiedListItem } from "@/components/common/unified-list-item";
import type { Recording } from "@/lib/recording/types";

const { Text } = Typography;

interface Props {
  onOpen: (recordingId: string) => void;
}

export function RecordingList({ onOpen }: Props) {
  const { t } = useTranslation();
  const { recordings, loading, error, refresh, rename, remove } =
    useRecordings();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  // Lazily loaded map of recordingId -> concatenated lowercase call URLs.
  const [urlIndex, setUrlIndex] = useState<Record<string, string>>({});
  const loadingIds = useRef<Set<string>>(new Set());

  useEffect(() => {
    const timer = setTimeout(
      () => setDebouncedSearch(search.trim().toLowerCase()),
      300,
    );
    return () => clearTimeout(timer);
  }, [search]);

  // When searching, ensure each recording's call URLs are indexed for matching.
  useEffect(() => {
    if (!debouncedSearch) return;
    let cancelled = false;
    recordings.forEach((rec) => {
      if (urlIndex[rec.id] !== undefined || loadingIds.current.has(rec.id))
        return;
      loadingIds.current.add(rec.id);
      getCalls(rec.id)
        .then((calls) => {
          if (cancelled) return;
          const joined = calls
            .map((c) => c.url)
            .join(" ")
            .toLowerCase();
          setUrlIndex((prev) => ({ ...prev, [rec.id]: joined }));
        })
        .catch(() => {
          if (!cancelled) setUrlIndex((prev) => ({ ...prev, [rec.id]: "" }));
        })
        .finally(() => loadingIds.current.delete(rec.id));
    });
    return () => {
      cancelled = true;
    };
  }, [debouncedSearch, recordings, urlIndex]);

  const filteredRecordings = useMemo(() => {
    if (!debouncedSearch) return recordings;
    return recordings.filter((rec) => {
      if (rec.name.toLowerCase().includes(debouncedSearch)) return true;
      return (urlIndex[rec.id] ?? "").includes(debouncedSearch);
    });
  }, [recordings, debouncedSearch, urlIndex]);

  if (loading) {
    return (
      <div className="p-8 text-center">
        <Spin />
      </div>
    );
  }

  if (error) {
    return (
      <div className="h-full flex items-center justify-center">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span>
              {t("recording.loadFailed")}
              <br />
              <Text type="secondary" className="text-xs">
                {error.message}
              </Text>
            </span>
          }
        >
          <Button size="small" onClick={() => refresh()}>
            {t("common.retry")}
          </Button>
        </Empty>
      </div>
    );
  }

  if (recordings.length === 0) {
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
          placeholder={t("recording.searchPlaceholder")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        {filteredRecordings.length === 0 ? (
          <div className="h-full flex items-center justify-center">
            <Empty
              image={Empty.PRESENTED_IMAGE_SIMPLE}
              description={t("recording.noMatch")}
            />
          </div>
        ) : (
          filteredRecordings.map((rec) => (
            <RecordingRow
              key={rec.id}
              recording={rec}
              onOpen={() => onOpen(rec.id)}
              onRename={(name) => rename(rec.id, name)}
              onRemove={() => remove(rec.id)}
            />
          ))
        )}
      </div>
    </div>
  );
}

function RecordingRow({
  recording,
  onOpen,
  onRename,
  onRemove,
}: {
  recording: Recording;
  onOpen: () => void;
  onRename: (name: string) => void;
  onRemove: () => void;
}) {
  const { modal } = App.useApp();
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(recording.name);

  const confirmDelete = () => {
    modal.confirm({
      title: t("recording.deleteRecordingTitle"),
      content: t("recording.deleteRecordingConfirm", { name: recording.name }),
      okText: t("common.delete"),
      okButtonProps: { danger: true },
      cancelText: t("common.cancel"),
      onOk: onRemove,
      centered: true,
    });
  };

  const commit = () => {
    const name = draft.trim();
    if (name && name !== recording.name) onRename(name);
    else setDraft(recording.name);
    setEditing(false);
  };

  return (
    <UnifiedListItem
      className="manta-action-kit-recording-item"
      clickable={!editing}
      onClick={() => !editing && onOpen()}
      menu={[
        {
          key: "rename",
          label: t("common.rename"),
          onClick: () => setEditing(true),
        },
        {
          key: "delete",
          label: t("common.delete"),
          danger: true,
          onClick: confirmDelete,
        },
      ]}
      title={
        editing ? (
          <Input
            autoFocus
            size="small"
            value={draft}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onPressEnter={commit}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setDraft(recording.name);
                setEditing(false);
              }
            }}
          />
        ) : (
          <Text ellipsis className="text-sm">
            {recording.name}
          </Text>
        )
      }
      status={
        <Tag color="blue" className="me-0 text-[10px]! font-normal! rounded">
          {t("recording.callCount", { count: recording.callCount })}
        </Tag>
      }
      timestamp={recording.createdAt}
    />
  );
}
