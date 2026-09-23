import { App, Button, Spin } from "antd";
import { CopyOutlined, DownloadOutlined } from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import GifPreviewView from "./gif-view";
import type { ScreenshotPreview } from "@/lib/screenshot/types";
import { screenshotPreview } from "@/lib/storage";

/**
 * Screenshot preview tab. Opened by the background right after a capture; the
 * image data arrives via session storage (`screenshotPreview` — too large for
 * a URL param). Shows the capture above a floating capsule toolbar with the
 * copy / download actions, so nothing leaves the browser without the user
 * seeing it first.
 *
 * The <img> is fed a blob URL, NOT the raw data URL: a full-page capture can
 * be tens of MB of base64, and rendering the data URL directly makes decoding
 * and scrolling visibly janky. The decoded blob is kept in a ref and reused by
 * both toolbar actions (fetch + decode happens once).
 */
/**
 * Two preview modes share this entrypoint: the screenshot capture (default)
 * and the GIF recording handoff (`?mode=gif`, opened by the background once
 * the offscreen recorder saved its WebM draft).
 */
export default function PreviewApp() {
  const isGifMode =
    new URLSearchParams(window.location.search).get("mode") === "gif";
  return isGifMode ? <GifPreviewView /> : <ScreenshotPreviewView />;
}

function ScreenshotPreviewView() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [shot, setShot] = useState<ScreenshotPreview | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const blobRef = useRef<Blob | null>(null);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | null = null;
    screenshotPreview.getValue().then(async (v) => {
      if (!v) return;
      setShot(v);
      // The tab title mirrors the future file name.
      document.title = v.filename;
      try {
        const blob = await (await fetch(v.dataUrl)).blob();
        objectUrl = URL.createObjectURL(blob);
        blobRef.current = blob;
        if (!cancelled) setImgUrl(objectUrl);
      } catch (err) {
        console.error("[preview] failed to decode screenshot", err);
      }
    });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, []);

  const copyImage = async () => {
    if (!shot) return;
    try {
      const blob =
        blobRef.current ?? (await (await fetch(shot.dataUrl)).blob());
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      message.success(t("common.copied"));
    } catch {
      message.error(t("common.copyFailed"));
    }
  };

  const downloadImage = async () => {
    if (!shot) return;
    try {
      const blob =
        blobRef.current ?? (await (await fetch(shot.dataUrl)).blob());
      // Blob URL, not the raw data: URL — anchors with multi-MB data: hrefs
      // are unreliable in Chrome. This page has a DOM, so createObjectURL is
      // available (unlike the service worker).
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = shot.filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      message.error(t("preview.downloadFailed"));
    }
  };

  if (!imgUrl) {
    return (
      <div className="h-screen bg-black flex items-center justify-center">
        {shot ? (
          <Spin />
        ) : (
          <span className="text-white/45">{t("preview.notFound")}</span>
        )}
      </div>
    );
  }

  return (
    /* Page layout: black backdrop, even padding all around; the image
       container fills the space ABOVE the capsule and is the ONLY scrollable
       region (natural-size mode scrolls inside it, edges stay put). */
    <div className="h-screen bg-black flex flex-col p-6 gap-4">
      <div
        className={
          zoomed
            ? "no-scrollbar flex-1 min-h-0 overflow-auto rounded-lg cursor-zoom-out"
            : "no-scrollbar flex-1 min-h-0 overflow-hidden rounded-lg flex items-center justify-center cursor-zoom-in"
        }
        onClick={() => setZoomed((z) => !z)}
      >
        <img
          src={imgUrl}
          alt={shot?.filename}
          decoding="async"
          draggable={false}
          className={
            zoomed ? "max-w-none block mx-auto" : "max-w-full max-h-full object-contain"
          }
        />
      </div>
      <div className="flex justify-center">
        <div className="flex items-center gap-1 rounded-full bg-(--ant-color-bg-elevated) shadow-xl border border-(--ant-color-border) px-3 py-1.5">
          <Button shape="round" type="text" icon={<CopyOutlined />} onClick={copyImage}>
            {t("common.copy")}
          </Button>
          <Button
            shape="round"
            type="primary"
            icon={<DownloadOutlined />}
            onClick={downloadImage}
          >
            {t("common.download")}
          </Button>
        </div>
      </div>
    </div>
  );
}
