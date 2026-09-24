import { App, Button, Spin, Tag, Tooltip } from "antd";
import {
  CheckCircleOutlined,
  CopyOutlined,
  DownOutlined,
  FileTextOutlined,
} from "@ant-design/icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  InspectorCapturePayload,
  InspectorDiffPair,
} from "@/lib/inspector/types";
import {
  diffPayloads,
  formatDiffReport,
  type NodeDiff,
} from "@/lib/inspector/diff";
import { getInspectorDiffPair } from "@/lib/db";
import { buildDom, createResetStyle, rootWidth } from "./element-build";

/**
 * Hover-spotlight rule injected into each pane's shadow root. The rebuilt
 * nodes carry their inline full styles, so the rules need `!important` to win;
 * the `all: initial` reset has zero specificity and is no obstacle.
 */
const HOVER_CSS =
  ".diff-hover{outline:2px solid #1677ff!important;outline-offset:2px!important;}";

/**
 * Element-capture comparison view (?mode=diff). Snapshot A is the capture the
 * user pinned from the element preview toolbar; snapshot B is the next
 * capture taken afterwards. The background writes the pair as one IndexedDB
 * record (`inspectorCaptures`, id "diffPair") and opens this tab. The pair
 * is intentionally NOT removed after reading, so refreshing the tab
 * restores the same comparison; the next comparison simply overwrites it.
 *
 * Layout: A and B are rebuilt side by side in separate Shadow DOMs (same
 * rules as the element preview, so both panes render with full fidelity),
 * with the property-level differences listed underneath as collapsible
 * cards (DOM path header, click to fold) — nodes are aligned
 * by tag order and compared on their full computed-style maps, so even
 * inherited-value changes surface.
 */
export default function ElementDiffView() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [pair, setPair] = useState<InspectorDiffPair | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    getInspectorDiffPair()
      .then((v) => {
        if (v) {
          setPair(v);
          document.title = "Element diff";
        }
      })
      .catch((err) =>
        console.error("[preview] failed to load element diff", err),
      )
      .finally(() => setLoaded(true));
  }, []);

  // Both shadow DOMs mount in one effect — A and B arrive together. A small
  // hover-highlight rule is injected next to the reset style: the diff rows
  // toggle a class on rebuilt nodes via their `data-ip` index path.
  useEffect(() => {
    if (!pair) return;
    for (const [id, payload] of [
      ["diff-host-a", pair.a],
      ["diff-host-b", pair.b],
    ] as const) {
      const host = document.getElementById(id);
      if (!host) continue;
      // Reuse the shadow root across StrictMode's double-invoked mount (a
      // shadow root, once attached, can never be re-attached or detached).
      const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
      const { root } = buildDom(payload.elements);
      const hoverStyle = document.createElement("style");
      hoverStyle.textContent = HOVER_CSS;
      // The effect re-runs on StrictMode remount and on every new pair, but
      // the (reused) shadow root keeps its children — clear before appending.
      shadow.replaceChildren(createResetStyle(), hoverStyle, root);
    }
  }, [pair]);

  const diff = useMemo(
    () => (pair ? diffPayloads(pair.a, pair.b) : null),
    [pair],
  );

  // The diff list below is rendered twice (once per side) so each column
  // lines up under its preview pane; cards in the two columns must fold in
  // lockstep, so the open/closed state lives here instead of in NodeDiffRow.
  const [openKeys, setOpenKeys] = useState<Record<string, boolean>>({});
  const toggleCard = (key: string) =>
    setOpenKeys((m) => ({ ...m, [key]: !m[key] }));
  // Scroll-sync the two diff columns: both hold equal-height cards, so
  // mirroring scrollTop keeps them aligned; the equality check makes the
  // mirrored scroll event a no-op instead of an echo.
  const listRefs = useRef<Partial<Record<"a" | "b", HTMLDivElement | null>>>(
    {},
  );
  const mirrorScroll = (side: "a" | "b") => {
    const from = listRefs.current[side];
    const to = listRefs.current[side === "a" ? "b" : "a"];
    if (from && to && to.scrollTop !== from.scrollTop) {
      to.scrollTop = from.scrollTop;
    }
  };

  const clipboard = async (text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      message.success(t("common.copied"));
    } catch {
      message.error(t("common.copyFailed"));
    }
  };

  const copyReport = () =>
    pair && diff && clipboard(formatDiffReport(pair.a, pair.b, diff));

  const copyJson = () => diff && clipboard(JSON.stringify(diff.nodes, null, 2));

  if (!loaded) {
    return (
      <div className="h-screen bg-black flex items-center justify-center">
        <Spin />
      </div>
    );
  }

  if (!pair || !diff) {
    return (
      <div className="h-screen bg-black flex items-center justify-center">
        <span className="text-white/45">{t("preview.diffMissing")}</span>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col p-6 gap-3 bg-[#f5f5f5]">
      {/* Side-by-side panes: A left, B right; each pane scrolls on its own
          and keeps the capture-time width of its root element. */}
      <div className="flex-1 min-h-0 flex gap-4">
        <DiffPane side="a" payload={pair.a} />
        <DiffPane side="b" payload={pair.b} />
      </div>

      {/* Property-level differences as two scroll-synced columns, each
          aligned under its preview pane (A left, B right). */}
      <div className="max-h-[38%] min-h-[64px] flex gap-4">
        {(["a", "b"] as const).map((side) => (
          <div
            key={side}
            ref={(el) => {
              listRefs.current[side] = el;
            }}
            onScroll={() => mirrorScroll(side)}
            className="flex-1 min-w-0 overflow-auto rounded-lg bg-(--ant-color-bg-elevated) border border-(--ant-color-border) p-4"
          >
            {diff.identical ? (
              <div className="flex items-center gap-2 text-[13px]">
                <CheckCircleOutlined className="text-(--ant-color-success)" />
                {t("preview.noDiff")}
              </div>
            ) : (
              <div className="flex flex-col gap-2">
                {diff.nodes.map((node) => (
                  <NodeDiffRow
                    key={node.path + node.kind}
                    side={side}
                    node={node}
                    open={!!openKeys[node.path + node.kind]}
                    onToggle={toggleCard}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Capsule toolbar, same grammar as the other preview views. */}
      <div className="flex justify-center">
        <div className="flex items-center gap-1 rounded-full bg-(--ant-color-bg-elevated) shadow-xl border border-(--ant-color-border) px-3 py-1.5">
          <Button
            shape="round"
            type="text"
            icon={<FileTextOutlined />}
            onClick={copyReport}
          >
            {t("preview.copyDiff")}
          </Button>
          <Button
            shape="round"
            type="text"
            icon={<CopyOutlined />}
            onClick={copyJson}
          >
            {t("preview.copyDiffJson")}
          </Button>
          <span className="text-xs text-(--ant-color-text-tertiary) px-2">
            {t("preview.diffCount", { count: diff.nodes.length })}
          </span>
        </div>
      </div>
    </div>
  );
}

function DiffPane({
  side,
  payload,
}: {
  side: "a" | "b";
  payload: InspectorCapturePayload;
}) {
  return (
    <div className="flex-1 min-w-0 flex flex-col gap-1.5">
      <div className="flex items-center gap-2 text-xs text-(--ant-color-text-secondary)">
        <Tag color={side === "a" ? "error" : "success"} className="m-0">
          {side.toUpperCase()}
        </Tag>
        <span className="truncate">{payload.page.title}</span>
        <Tooltip title={payload.page.url}>
          <span className="truncate opacity-60">{payload.page.url}</span>
        </Tooltip>
      </div>
      <div className="no-scrollbar flex-1 min-h-0 overflow-auto rounded-lg bg-white border border-(--ant-color-border) flex p-4">
        <div
          id={`diff-host-${side}`}
          style={{
            width: rootWidth(payload.elements),
            flex: "0 0 auto",
            margin: "auto",
          }}
        />
      </div>
    </div>
  );
}

function NodeDiffRow({
  side,
  node,
  open,
  onToggle,
}: {
  side: "a" | "b";
  node: NodeDiff;
  open: boolean;
  onToggle: (key: string) => void;
}) {
  // Each block is a collapsible card rendered once per column: DOM path as the
  // header, this side's property values as the body; clicking the header
  // toggles the shared open state so both columns fold together. Presence
  // blocks (only-in-A/B) have no property rows to show — the pane's hover
  // spotlight already reveals their position and content — so they render
  // no toggle at all.
  const hasBody =
    node.kind === "changed" &&
    (node.styleChanges.length > 0 ||
      node.pseudoChanges.length > 0 ||
      !!node.textChange);
  // A node that exists only on the other side is a layout ghost in this
  // column: it still occupies the same height (keeping the sibling column
  // aligned) but is invisible and non-interactive (`visibility: hidden`
  // swallows pointer events, so no hover/click side effects either).
  const foreignOnly =
    (side === "a" && node.kind === "only-b") ||
    (side === "b" && node.kind === "only-a");
  // Flat, ordered change rows; both columns render from the same list, so a
  // given property sits at the same vertical position on either side.
  const rows: { label: string; a?: string; b?: string }[] = [];
  if (node.textChange) {
    rows.push({ label: "text", a: node.textChange.a, b: node.textChange.b });
  }
  for (const c of node.styleChanges) {
    rows.push({ label: c.prop, a: c.a, b: c.b });
  }
  for (const p of node.pseudoChanges) {
    for (const c of p.changes) {
      rows.push({ label: `::${p.pseudo} ${c.prop}`, a: c.a, b: c.b });
    }
  }
  // Card colors form a tri-color grammar matching the kind: red = gone in B
  // (only-a), green = new in B (only-b), blue = modified — the same blue as
  // the hover-spotlight outline, so "changed" reads as one family with the
  // spotlight interaction.
  // Hovering a row spotlights the rebuilt node in both preview panes: the
  // rebuilt DOM tags every node with data-ip (its structural index path), so
  // we just toggle a class on the match inside each pane's shadow root and
  // scroll it into view.
  const setHover = (active: boolean) => {
    for (const [hostId, idx] of [
      ["diff-host-a", node.aIdx],
      ["diff-host-b", node.bIdx],
    ] as const) {
      if (!idx) continue;
      const el = document
        .getElementById(hostId)
        ?.shadowRoot?.querySelector(`[data-ip="${idx.join("/")}"]`);
      if (!el) continue;
      el.classList.toggle("diff-hover", active);
      if (active) el.scrollIntoView({ block: "center", inline: "nearest" });
    }
  };
  return (
    <div
      className={`${foreignOnly ? "invisible" : ""} rounded-md border min-w-0 max-w-full overflow-hidden ${
        node.kind === "only-a"
          ? "bg-(--ant-color-error-bg) border-(--ant-color-error-border) border-l-[3px] border-l-(--ant-color-error)"
          : node.kind === "only-b"
            ? "bg-(--ant-color-success-bg) border-(--ant-color-success-border) border-l-[3px] border-l-(--ant-color-success)"
            : "bg-(--ant-color-primary-bg) border-(--ant-color-primary-border) border-l-[3px] border-l-(--ant-color-primary)"
      }`}
    >
      <div
        onClick={hasBody ? () => onToggle(node.path + node.kind) : undefined}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        className="flex items-center gap-2 overflow-hidden px-4 py-2 cursor-pointer select-none text-[13px] leading-[22px]"
      >
        <code className="min-w-0 flex-1 truncate text-xs font-mono leading-[22px]">
          {node.path}
        </code>
        {hasBody && (
          <DownOutlined
            className={`shrink-0 text-(--ant-color-text-tertiary) transition-transform ${
              open ? "" : "-rotate-90"
            }`}
          />
        )}
      </div>
      {open && hasBody && (
        <div className="px-4 pb-4">
          <div className="flex flex-col gap-0.5 rounded-md bg-white/88 border border-(--ant-color-border-secondary) px-3 py-2">
            {rows.map((r) => (
              <div
                key={r.label}
                className="flex gap-1.5 items-baseline min-w-0 font-mono text-xs leading-[22px]"
              >
                <span className="shrink-0 opacity-70">{r.label}:</span>
                {/* Fixed two-line height so the same row in the sibling
                    column occupies identical space — the columns must stay
                    vertically aligned even when only one side wraps. */}
                <span
                  className={`break-all line-clamp-2 min-w-0 flex-1 ${
                    side === "a"
                      ? "text-(--ant-color-error)"
                      : "text-(--ant-color-success)"
                  }`}
                >
                  {(side === "a" ? r.a : r.b) ?? "—"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
