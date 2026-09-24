import { App, Button, Dropdown, Spin } from "antd";
import {
  BgColorsOutlined,
  CodeOutlined,
  CopyOutlined,
  DiffOutlined,
  DownOutlined,
  RobotOutlined,
} from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { InspectorCapturePayload } from "@/lib/inspector/types";
import { getInspectorCapture, saveInspectorCapture } from "@/lib/db";
import {
  buildDom,
  createResetStyle,
  leanPayload,
  rootWidth,
} from "./element-build";

/**
 * Element-capture preview view (opened at /preview.html?mode=element right
 * after an inspector capture). The payload arrives via IndexedDB
 * (`inspectorCaptures`, id "preview" — full snapshots can exceed any
 * session-storage quota) and stays there: the view reads it into state, and
 * refreshing the tab restores the same capture (the record is simply
 * overwritten by the next capture).
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
 * The floating toolbar offers four copy targets: the rebuilt HTML (with
 * pseudo-element rules), the lean JSON (same as the capture clipboard —
 * fullStyles/pseudo/textFull stripped), the full snapshot JSON, and an
 * agent-ready prompt wrapping the HTML.
 */
export default function ElementPreviewView() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [payload, setPayload] = useState<InspectorCapturePayload | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [darkBackdrop, setDarkBackdrop] = useState(false);
  const [pinned, setPinned] = useState(false);
  /** Latest rebuilt DOM node — serialized on demand for the copy menu. */
  const rootRef = useRef<HTMLElement | null>(null);
  const pseudoCssRef = useRef<string>("");
  const payloadRef = useRef<InspectorCapturePayload | null>(null);

  useEffect(() => {
    getInspectorCapture("preview")
      .then(async (v) => {
        if (!v) return;
        setPayload(v);
        payloadRef.current = v;
        document.title = "Element preview";
        // Left in IndexedDB (NOT removed after reading): refreshing the tab
        // restores the same capture, same contract as the diff pair. The next
        // capture simply overwrites the record — an already-open preview keeps
        // its own React state and is never disturbed.
      })
      .catch((err) =>
        console.error("[preview] failed to load element capture", err),
      )
      .finally(() => setLoaded(true));
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
          title: v.page.title,
          url: v.page.url,
          html: snapshotHtml(),
          interpolation: { escapeValue: false },
        }),
      );
    }
  };

  /**
   * Pin this snapshot as the comparison baseline: the NEXT capture anywhere
   * becomes snapshot B and opens the diff view (one-shot, cleared by the
   * background). A fresh pin replaces any previous one.
   */
  const pinBaseline = async () => {
    const v = payloadRef.current;
    if (!v) return;
    try {
      await saveInspectorCapture("baseline", v);
      setPinned(true);
      message.success(t("preview.pinned"));
    } catch {
      message.error(t("preview.pinFailed"));
    }
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

  return (
    /* Same layout grammar as the screenshot/GIF views: the rebuilt element
       fills the space above a floating capsule toolbar. The host keeps the
       capture-time size of the root element; oversize scrolls. */
    <div
      className="h-screen flex flex-col p-6 gap-4"
      style={{ background: darkBackdrop ? "#000" : "#f5f5f5" }}
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
              {t("preview.copy")} <DownOutlined />
            </Button>
          </Dropdown>
          <Button
            shape="round"
            type="primary"
            icon={<BgColorsOutlined />}
            onClick={() => setDarkBackdrop((d) => !d)}
          >
            {t("preview.toggleBackdrop")}
          </Button>
          <Button
            shape="round"
            type={pinned ? "primary" : "text"}
            icon={<DiffOutlined />}
            onClick={pinBaseline}
          >
            {t("preview.pinBaseline")}
          </Button>
        </div>
      </div>
    </div>
  );
}
