import { App, Button, Spin } from "antd";
import { DownloadOutlined, VideoCameraOutlined } from "@ant-design/icons";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ALL_FORMATS,
  BlobSource,
  BufferTarget,
  Conversion,
  Input,
  Mp4OutputFormat,
  Output,
  QUALITY_HIGH,
} from "mediabunny";
import { getGifDraft } from "@/lib/db";
import { encodeGif } from "@/lib/gif-recording/encode";
import type { GifDraft } from "@/lib/gif-recording/types";

/**
 * GIF-recording preview view (opened at /preview.html?mode=gif right after the
 * recording stops). The recorded WebM arrives from IndexedDB (`gifDrafts`,
 * written by the offscreen recorder) and plays in a native <video>. The capsule
 * offers two downloads: the original WebM as-is, and a GIF converted HERE, in a
 * visible tab — requestVideoFrameCallback needs a composited page (the hidden
 * offscreen document starved the frame callbacks and hung the pipeline; see
 * lib/gif-recording/encode.ts). Conversion plays out over the clip duration,
 * so the GIF button reports progress with tabular numerals.
 */
export default function GifPreviewView() {
  const { t } = useTranslation();
  const { message } = App.useApp();
  const [draft, setDraft] = useState<GifDraft | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  const [encoding, setEncoding] = useState(false);
  const [converting, setConverting] = useState(false);
  const [percent, setPercent] = useState(0);
  const blobRef = useRef<Blob | null>(null);
  /** Encoded GIF cache — repeat clicks download instantly, no re-encode. */
  const gifBlobRef = useRef<Blob | null>(null);
  /** Converted MP4 cache — same idea as `gifBlobRef`. */
  const mp4BlobRef = useRef<Blob | null>(null);

  useEffect(() => {
    let objectUrl: string | null = null;
    getGifDraft("latest")
      .then(async (d) => {
        if (!d) return;
        setDraft(d);
        document.title = d.filename;
        blobRef.current = d.blob;
        objectUrl = URL.createObjectURL(d.blob);
        setVideoUrl(objectUrl);
      })
      .catch((err) => console.error("[preview] failed to load GIF draft", err))
      .finally(() => setLoaded(true));
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, []);

  /** Same anchor download as the screenshot view — this page has a DOM. */
  const downloadBlob = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  /**
   * "Download video": transcode the recorded WebM to MP4 (H.264 via WebCodecs,
   * through mediabunny) so the download plays everywhere. Recording stays VP8 —
   * software-encoded and reliable; MediaRecorder's direct MP4/H.264 path has
   * known silent-failure modes on high-resolution captures. If the conversion
   * fails for any reason, fall back to the original WebM rather than losing
   * the recording.
   */
  const downloadVideo = async () => {
    const blob = blobRef.current;
    if (!blob || !draft) return;
    const mp4Name = draft.filename
      .replace(/^gif-/, "recording-")
      .replace(/\.gif$/, ".mp4");
    // Second+ click: the converted MP4 is cached — download it right away.
    if (mp4BlobRef.current) {
      downloadBlob(mp4BlobRef.current, mp4Name);
      message.success(t("preview.videoSaved"));
      return;
    }
    setConverting(true);
    setPercent(0);
    try {
      const target = new BufferTarget();
      const conversion = await Conversion.init({
        input: new Input({ source: new BlobSource(blob), formats: ALL_FORMATS }),
        output: new Output({ format: new Mp4OutputFormat(), target }),
        video: { codec: "avc", quality: QUALITY_HIGH },
      });
      conversion.onProgress = (p) => setPercent(Math.round(p * 100));
      await conversion.execute();
      const buffer = target.buffer;
      if (!buffer) throw new Error("empty conversion output");
      const mp4 = new Blob([buffer], { type: "video/mp4" });
      mp4BlobRef.current = mp4;
      downloadBlob(mp4, mp4Name);
      message.success(t("preview.videoSaved"));
    } catch (err) {
      console.error("[preview] WebM→MP4 conversion failed", err);
      // Still hand over SOMETHING — the original WebM plays in Chrome at least.
      downloadBlob(blob, draft.filename.replace(/^gif-/, "recording-").replace(/\.gif$/, ".webm"));
      message.warning(t("preview.videoConvertFailed"));
    } finally {
      setConverting(false);
    }
  };

  const downloadGif = async () => {
    const blob = blobRef.current;
    if (!blob || !draft) return;
    // Second+ click: the encoded GIF is cached — download it right away.
    if (gifBlobRef.current) {
      downloadBlob(gifBlobRef.current, draft.filename);
      message.success(t("preview.gifSaved"));
      return;
    }
    setEncoding(true);
    setPercent(0);
    try {
      const gif = await encodeGif(blob, setPercent);
      gifBlobRef.current = gif;
      downloadBlob(gif, draft.filename);
      message.success(t("preview.gifSaved"));
    } catch (err) {
      console.error("[preview] GIF encoding failed", err);
      message.error(t("preview.gifEncodeFailed"));
    } finally {
      setEncoding(false);
    }
  };

  if (!loaded) {
    return (
      <div className="h-screen bg-black flex items-center justify-center">
        <Spin />
      </div>
    );
  }

  if (!videoUrl) {
    return (
      <div className="h-screen bg-black flex items-center justify-center">
        <span className="text-white/45">{t("preview.gifDraftNotFound")}</span>
      </div>
    );
  }

  return (
    /* Same layout grammar as the screenshot view: black backdrop, media fills
       the space above a floating capsule toolbar. */
    <div className="h-screen bg-black flex flex-col p-6 gap-4">
      <div className="no-scrollbar flex-1 min-h-0 overflow-hidden rounded-lg flex items-center justify-center">
        <video
          src={videoUrl}
          controls
          autoPlay
          loop
          muted
          className="max-w-full max-h-full"
        />
      </div>
      <div className="flex justify-center">
        <div className="flex items-center gap-1 rounded-full bg-(--ant-color-bg-elevated) shadow-xl border border-(--ant-color-border) px-3 py-1.5">
          <Button
            shape="round"
            type="text"
            icon={<VideoCameraOutlined />}
            loading={converting}
            disabled={encoding}
            onClick={downloadVideo}
          >
            {/* Tabular numerals so the percent readout doesn't jiggle. */}
            <span className="tabular-nums">
              {converting
                ? t("preview.convertingVideo", { percent })
                : t("preview.downloadVideo")}
            </span>
          </Button>
          <Button
            shape="round"
            type="primary"
            icon={<DownloadOutlined />}
            loading={encoding}
            disabled={converting}
            onClick={downloadGif}
          >
            <span className="tabular-nums">
              {encoding
                ? t("preview.generatingGif", { percent })
                : t("preview.downloadGif")}
            </span>
          </Button>
        </div>
      </div>
    </div>
  );
}
