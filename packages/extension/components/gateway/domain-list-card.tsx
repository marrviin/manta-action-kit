import { App, Button, Input, Typography } from "antd";
import { CheckOutlined, CloseOutlined, DeleteOutlined } from "@ant-design/icons";
import { useTranslation } from "react-i18next";
import { useState } from "react";
import { UnifiedListItem } from "@/components/common/unified-list-item";
import { normalizeDomain } from "@/lib/gateway/authorize";

const { Text } = Typography;

/**
 * Allow/deny domain management card. Inline add row (input + confirm/cancel,
 * validated with normalizeDomain) over a list of domain rows with a hover
 * delete menu — same visual system as the rest of the panel. Domains match
 * themselves and all their subdomains (see matchesDomain in authorize.ts).
 * Empty state is a collapsed card (header only); the list area appears once
 * content exists.
 */
export function DomainListCard({
  title,
  description,
  domains,
  onChange,
}: {
  title: string;
  description: string;
  domains: string[];
  onChange: (next: string[]) => void;
}) {
  const { message } = App.useApp();
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");

  const submit = () => {
    const domain = normalizeDomain(draft);
    if (!domain) {
      message.error(t("gateway.domainInvalid"));
      return;
    }
    if (domains.some((d) => d === domain)) {
      message.error(t("gateway.domainDuplicate"));
      return;
    }
    onChange([...domains, domain].sort());
    setDraft("");
    setAdding(false);
    message.success(t("gateway.domainAdded"));
  };

  return (
    <section className="flex-none rounded-xl border border-(--ant-color-border-secondary) bg-(--ant-color-bg-container) overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-3 py-2.5 border-b border-(--ant-color-border-secondary)">
        <div className="min-w-0">
          <Text strong className="text-sm block">
            {title}
          </Text>
          <Text type="secondary" className="text-xs!">
            {description}
          </Text>
        </div>
        <Button className="flex-none" onClick={() => setAdding(true)}>
          {t("common.add")}
        </Button>
      </div>

      {adding && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-(--ant-color-border-secondary)">
          <Input
            autoFocus
            allowClear
            placeholder={t("gateway.addDomainPlaceholder")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPressEnter={submit}
            className="flex-1 min-w-0"
          />
          <Button
            type="text"
            size="small"
            className="flex-none w-6 h-6 p-0"
            disabled={!draft.trim()}
            icon={<CheckOutlined className="text-(--ant-color-success)" />}
            onClick={submit}
          />
          <Button
            type="text"
            size="small"
            className="flex-none w-6 h-6 p-0"
            icon={<CloseOutlined className="text-(--ant-color-text-quaternary)" />}
            onClick={() => {
              setAdding(false);
              setDraft("");
            }}
          />
        </div>
      )}

      {domains.length > 0 &&
        domains.map((domain) => (
          <UnifiedListItem
            key={domain}
            // Hover-revealed direct delete (no three-dot menu).
            actions={
              <Button
                type="text"
                size="small"
                className="w-5 h-5 p-0 text-xs"
                icon={<DeleteOutlined />}
                onClick={() => onChange(domains.filter((d) => d !== domain))}
              />
            }
            title={
              <Text ellipsis className="text-sm block" title={domain}>
                {domain}
              </Text>
            }
          />
        ))}
    </section>
  );
}
