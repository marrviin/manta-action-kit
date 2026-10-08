import { App, Button, Dropdown, Spin } from "antd";
import {
  CodeOutlined,
  CopyOutlined,
  DiffOutlined,
  RobotOutlined,
} from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { InspectorCapturePayload } from "@/lib/inspector/types";
import {
  getInspectorCapture,
  listInspectorCaptures,
  type InspectorHistoryEntry,
} from "@/lib/db";
import {
  buildDom,
  createResetStyle,
  leanPayload,
  rootWidth,
} from "./element-build";

/**
 * Element-capture preview view (opened at /preview.html?mode=element&id=<uuid>
 * right after an inspector capture). The payload lives in IndexedDB as its own
 * history record (`inspectorCaptures`, uuid id passed in the URL — full
 * snapshots can exceed any session-storage quota); the view reads it into
 * state, and refreshing the tab restores the same capture because the id is
 * addressable. With no id in the URL (legacy link) it falls back to the newest
 * record.
 *
 * The captured element tree is rebuilt inside a Shadow DOM so the preview
 * page's own styles (antd/Tailwind) can't leak in. Fidelity now comes from
 * the capture-side `fullStyles` map: every node carries its full computed
 * styles from capture time and the rebuild inlines them node by node, so
 * CSS inheritance and the reset stylesheet no longer decide the outcome
 * (payloads captured before `fullStyles` existed fall back to the trimmed
 * `styles` + reset approach). Pseudo-elements can't be inlined, so they are
 * re-attached via generated `[data-pe]` rules inside the shadow root.
 *
 * The floating toolbar offers four copy targets (the rebuilt HTML with
 * pseudo-element rules, the lean JSON — same as the capture clipboard —
 * the full snapshot JSON, and an agent-ready prompt wrapping the HTML) and a
 * compare dropdown that diffs this capture against any other history record
 * on the spot.
 */
export default function ElementPreviewView() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [payload, setPayload] = useState<InspectorCapturePayload | null>(null);
  const [captureId, setCaptureId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  /** History entries for the compare dropdown, loaded when it opens. */
  const [history, setHistory] = useState<InspectorHistoryEntry[]>([]);
  /** Latest rebuilt DOM node — serialized on demand for the copy menu. */
  const rootRef = useRef<HTMLElement | null>(null);
  const pseudoCssRef = useRef<string>("");
  const payloadRef = useRef<InspectorCapturePayload | null>(null);

  useEffect(() => {
    const urlId = new URLSearchParams(window.location.search).get("id");
    (async () => {
      try {
        let entry: InspectorHistoryEntry | undefined;
        if (urlId) {
          const v = await getInspectorCapture(urlId);
          if (v) entry = { id: urlId, payload: v };
        } else {
          // No id in the URL (stale/legacy link): show the newest record.
          [entry] = await listInspectorCaptures();
        }
        if (entry) {
          setPayload(entry.payload);
          payloadRef.current = entry.payload;
          setCaptureId(entry.id);
          document.title = "Element preview";
        }
      } catch (err) {
        console.error("[preview] failed to load element capture", err);
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!payload) return;
    const host = document.getElementById("element-host");
    if (!host) return;
    // StrictMode double-invokes this effect on the same host element, and a
    // shadow root — once attached — can never be detached (the cleanup below
    // only clears its children). Re-attaching would throw NotSupportedError
    // and crash the whole view, so reuse the existing root instead.
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    const { root, pseudoCss } = buildDom(payload.elements);
    rootRef.current = root;
    pseudoCssRef.current = pseudoCss;
    shadow.append(createResetStyle(), root);
    return () => {
      shadow.replaceChildren();
      rootRef.current = null;
      pseudoCssRef.current = "";
    };
  }, [payload]);

  /** Serialized snapshot as HTML: rebuilt tree + pseudo-element rules. */
  const snapshotHtml = () => {
    const root = rootRef.current;
    if (!root) return "";
    const pseudo = pseudoCssRef.current;
    return pseudo
      ? `<style>\n${pseudo}\n</style>\n${root.outerHTML}`
      : root.outerHTML;
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

  const onCopy = async (key: string) => {
    const v = payloadRef.current;
    if (!v) return;
    if (key === "html") {
      await clipboard(snapshotHtml());
    } else if (key === "lean") {
      await clipboard(JSON.stringify(leanPayload(v), null, 2));
    } else if (key === "full") {
      await clipboard(JSON.stringify(v, null, 2));
    } else if (key === "agent") {
      await clipboard(
        t("preview.agentPrompt", {
          title: v.page?.title ?? "",
          url: v.page?.url ?? "",
          html: snapshotHtml(),
          interpolation: { escapeValue: false },
        }),
      );
    }
  };

  /** Open the diff view: this capture as A, the picked history record as B. */
  const compareWith = (otherId: string) => {
    if (!captureId) return;
    window.location.assign(
      `/preview.html?mode=diff&a=${captureId}&b=${otherId}`,
    );
  };

  if (!loaded) {
    return (
      <div className="h-screen bg-black flex items-center justify-center">
        <Spin />
      </div>
    );
  }

  if (!payload) {
    return (
      <div className="h-screen bg-black flex items-center justify-center">
        <span className="text-white/45">{t("preview.elementNotFound")}</span>
      </div>
    );
  }

  const otherCaptures = history.filter((h) => h.id !== captureId);

  return (
    /* Same layout grammar as the screenshot/GIF views: the rebuilt element
       fills the space above a floating capsule toolbar. The host keeps the
       capture-time size of the root element; oversize scrolls. */
    <div
      className="h-screen flex flex-col p-6 gap-4"
      style={{ background: "#f5f5f5" }}
    >
      <div className="no-scrollbar flex-1 min-h-0 overflow-auto rounded-lg flex">
        <div
          id="element-host"
          style={{
            width: rootWidth(payload.elements),
            flex: "0 0 auto",
            margin: "auto",
          }}
        />
      </div>
      <div className="flex justify-center">
        <div className="flex items-center gap-1 rounded-full bg-(--ant-color-bg-elevated) shadow-xl border border-(--ant-color-border) px-3 py-1.5">
          <Dropdown
            menu={{
              items: [
                {
                  key: "html",
                  icon: <CodeOutlined />,
                  label: t("preview.copyHtml"),
                },
                {
                  key: "lean",
                  icon: <CopyOutlined />,
                  label: t("preview.copyLeanJson"),
                },
                {
                  key: "full",
                  icon: <CopyOutlined />,
                  label: t("preview.copyFullJson"),
                },
                {
                  key: "agent",
                  icon: <RobotOutlined />,
                  label: t("preview.copyAgent"),
                },
              ],
              onClick: ({ key }) => void onCopy(key),
            }}
            trigger={["click"]}
          >
            <Button shape="round" type="text" icon={<CopyOutlined />}>
              {t("preview.copy")}
            </Button>
          </Dropdown>
          {/* Compare with another history record: the dropdown lists the
              capture history (newest first, this one excluded); picking one
              navigates straight to the diff view. */}
          <Dropdown
            menu={{
              items:
                otherCaptures.length > 0
                  ? otherCaptures.map((h) => ({
                      key: h.id,
                      label: (
                        <span
                          title={h.payload.page?.url}
                          className="flex items-center gap-2 max-w-[280px]"
                        >
                          <span className="truncate">
                            {h.payload.page?.title ||
                              h.payload.page?.url ||
                              t("capture.untitledCapture")}
                          </span>
                          <span className="shrink-0 text-(--ant-color-text-tertiary) text-xs">
                            {new Date(h.payload.capturedAt).toLocaleString()}
                          </span>
                        </span>
                      ),
                    }))
                  : [{ key: "empty", label: t("preview.compareEmpty"), disabled: true }],
              onClick: ({ key }) => compareWith(key),
            }}
            onOpenChange={(open) => {
              if (open)
                listInspectorCaptures()
                  .then(setHistory)
                  .catch((err) =>
                    console.error("[preview] failed to list captures", err),
                  );
            }}
            trigger={["click"]}
          >
            <Button shape="round" type="text" icon={<DiffOutlined />}>
              {t("preview.compare")}
            </Button>
          </Dropdown>
        </div>
      </div>
    </div>
  );
}
