// fallow-ignore-file complexity
/**
 * GPU Encoder Detection
 *
 * Shared GPU encoder detection and naming utilities used by both
 * chunkEncoder and streamingEncoder services.
 */

import { spawn } from "child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "fs";
import { arch, homedir, platform, release } from "os";
import { dirname, isAbsolute, join } from "path";
import { getFfmpegBinary } from "./ffmpegBinaries.js";
import { ManagedChildProcess } from "./managedChildProcess.js";
import { trackChildProcess } from "./processTracker.js";

export type ConcreteGpuEncoder = "nvenc" | "videotoolbox" | "vaapi" | "qsv" | "amf";
export type GpuEncoder = ConcreteGpuEncoder | null;

const GPU_ENCODER_CANDIDATES: ConcreteGpuEncoder[] = [
  "nvenc",
  "videotoolbox",
  "vaapi",
  "qsv",
  "amf",
];

const H264_ENCODER_BY_GPU: Record<ConcreteGpuEncoder, string> = {
  nvenc: "h264_nvenc",
  videotoolbox: "h264_videotoolbox",
  vaapi: "h264_vaapi",
  qsv: "h264_qsv",
  amf: "h264_amf",
};

const GPU_PROBE_TIMEOUT_MS = 2000;
const GPU_PROBE_KILL_GRACE_MS = 1000;

export function getCompiledGpuEncoders(ffmpegEncodersStdout: string): ConcreteGpuEncoder[] {
  return GPU_ENCODER_CANDIDATES.filter((encoder) =>
    ffmpegEncodersStdout.includes(H264_ENCODER_BY_GPU[encoder]),
  );
}

export async function selectUsableGpuEncoder(
  candidates: readonly ConcreteGpuEncoder[],
  isUsable: (encoder: ConcreteGpuEncoder) => Promise<boolean>,
): Promise<GpuEncoder> {
  const results = await Promise.all(
    candidates.map(async (encoder) => {
      try {
        return { encoder, usable: await isUsable(encoder) };
      } catch {
        return { encoder, usable: false };
      }
    }),
  );

  for (const result of results) {
    if (result.usable) {
      return result.encoder;
    }
  }
  return null;
}

export async function detectGpuEncoder(): Promise<GpuEncoder> {
  return (await probeGpuEncoder()).encoder;
}

/** The probe, and whether FFmpeg listed its encoders at all: only an answer from a listing is worth keeping. */
async function probeGpuEncoder(): Promise<{ encoder: GpuEncoder; listed: boolean }> {
  const ffmpeg = spawn(getFfmpegBinary(), ["-encoders"], {
    stdio: ["pipe", "pipe", "pipe"],
    // See runFfmpeg.ts: keeps a console window off the user's desktop on Windows.
    windowsHide: true,
  });
  trackChildProcess(ffmpeg);
  let stdout = "";
  ffmpeg.stdout.on("data", (data) => {
    stdout += data.toString();
  });
  const outcome = await new ManagedChildProcess(ffmpeg, {
    deadlineAtMs: Date.now() + 30_000,
  }).wait();
  if (outcome.reason !== "exit" || outcome.exitCode !== 0) return { encoder: null, listed: false };
  const candidates = getCompiledGpuEncoders(stdout);
  const encoder = await selectUsableGpuEncoder(candidates, canUseGpuEncoder).catch(() => null);
  return { encoder, listed: true };
}

/** Where this machine's answer is kept between renders: a GPU encoder that fails can take seconds to say so. */
const KEPT_PROBES = join(homedir(), ".cache", "hyperframes", "gpu-encoder.json");
/** A kept answer is asked again after this, in case a driver changed under the same FFmpeg and OS. */
const KEPT_PROBE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

type KeptProbe = { key: string; encoder: GpuEncoder; at: number };

/** What the answer depends on: this FFmpeg build (path, size, modified time) on this OS. Null for a bare name that
 * only PATH resolves, which has no file to tell builds apart. */
export function gpuProbeKey(ffmpegPath: string): string | null {
  if (!isAbsolute(ffmpegPath)) return null;
  try {
    const { size, mtimeMs } = statSync(ffmpegPath);
    return [ffmpegPath, size, Math.round(mtimeMs), platform(), arch(), release()].join("|");
  } catch {
    return null;
  }
}

function readKeptProbes(file: string): Record<string, KeptProbe> {
  try {
    const kept: unknown = JSON.parse(readFileSync(file, "utf8"));
    return kept && typeof kept === "object" ? (kept as Record<string, KeptProbe>) : {};
  } catch {
    return {};
  }
}

/** The kept answer for `key`, or undefined when there is none, it is stale, or its encoder is not one we know. */
export function keptGpuEncoder(
  file: string,
  ffmpegPath: string,
  key: string,
  now = Date.now(),
): GpuEncoder | undefined {
  const kept = readKeptProbes(file)[ffmpegPath];
  if (!kept || kept.key !== key || !(now - kept.at < KEPT_PROBE_MAX_AGE_MS)) return undefined;
  if (kept.encoder === null || GPU_ENCODER_CANDIDATES.includes(kept.encoder)) return kept.encoder;
  return undefined;
}

/** Best effort: a home the render cannot write (a read-only container) only means the next render probes again. */
export function keepGpuEncoder(
  file: string,
  ffmpegPath: string,
  key: string,
  encoder: GpuEncoder,
  now = Date.now(),
) {
  try {
    mkdirSync(dirname(file), { recursive: true });
    const kept = { ...readKeptProbes(file), [ffmpegPath]: { key, encoder, at: now } };
    writeFileSync(file, JSON.stringify(kept));
  } catch {
    // Not kept: the next render probes again.
  }
}

let cachedGpuEncoder: Promise<GpuEncoder> | undefined = undefined;

/** The one probe answer a process uses, from memory, then from the machine's kept answer, then a fresh probe. */
export function getCachedGpuEncoder(file = KEPT_PROBES): Promise<GpuEncoder> {
  cachedGpuEncoder ??= probeOrKept(file);
  return cachedGpuEncoder;
}

async function probeOrKept(file: string): Promise<GpuEncoder> {
  const ffmpegPath = getFfmpegBinary();
  const key = gpuProbeKey(ffmpegPath);
  const kept = key === null ? undefined : keptGpuEncoder(file, ffmpegPath, key);
  if (kept !== undefined) return kept;
  const { encoder, listed } = await probeGpuEncoder();
  if (key !== null && listed) keepGpuEncoder(file, ffmpegPath, key, encoder);
  return encoder;
}

/** Tests only: forget the process's answer. */
export function resetCachedGpuEncoder() {
  cachedGpuEncoder = undefined;
}

export function getGpuEncoderName(encoder: GpuEncoder, codec: "h264" | "h265"): string {
  if (!encoder) return codec === "h264" ? "libx264" : "libx265";
  switch (encoder) {
    case "nvenc":
      return codec === "h264" ? "h264_nvenc" : "hevc_nvenc";
    case "videotoolbox":
      return codec === "h264" ? "h264_videotoolbox" : "hevc_videotoolbox";
    case "vaapi":
      return codec === "h264" ? "h264_vaapi" : "hevc_vaapi";
    case "qsv":
      return codec === "h264" ? "h264_qsv" : "hevc_qsv";
    case "amf":
      return codec === "h264" ? "h264_amf" : "hevc_amf";
    default:
      return codec === "h264" ? "libx264" : "libx265";
  }
}

export function buildVideoToolboxRateControlArgs(input: {
  bitrate?: string;
  width: number;
  height: number;
  fps: number;
  quality: number;
}): string[] {
  if (input.bitrate) return ["-b:v", input.bitrate, "-allow_sw", "1"];

  // VideoToolbox rejects FFmpeg's generic qscale path on supported macOS
  // builds. Derive a bitrate from pixel rate instead: the three CRF-shaped
  // quality tiers map to roughly 5M / 10M / 12M at 1080p24.
  const bitsPerPixel = input.quality <= 15 ? 0.24 : input.quality <= 18 ? 0.16 : 0.08;
  const megabitsPerSecond = Math.max(
    1,
    Math.round((input.width * input.height * input.fps * bitsPerPixel) / 1_000_000),
  );
  return ["-b:v", `${megabitsPerSecond}M`, "-allow_sw", "1"];
}

// Minimum probe dimensions must clear every GPU encoder's hardware minimum.
// NVIDIA data-center SKUs (L4/T4/A10/A100) reject frames below ~257px on
// either dimension with "Frame Dimension less than the minimum supported
// value" (observed on driver 595.58.03, CUDA 13.2). The documented SDK
// minimums (145×49 H.264, 129×33 HEVC) are lower, but the driver enforces
// a stricter per-SKU alignment. 320×240 clears all known GPU encoder
// minimums (NVENC, VideoToolbox, VAAPI, QSV, AMF) while staying cheap.
const GPU_PROBE_WIDTH = 320;
const GPU_PROBE_HEIGHT = 240;

export function getProbeArgs(encoder: ConcreteGpuEncoder): string[] {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-f",
    "lavfi",
    "-i",
    `color=size=${GPU_PROBE_WIDTH}x${GPU_PROBE_HEIGHT}:rate=1:duration=1`,
    "-frames:v",
    "1",
    "-an",
  ];

  if (encoder === "vaapi") {
    args.push("-vaapi_device", "/dev/dri/renderD128", "-vf", "format=nv12,hwupload");
  }

  args.push("-c:v", getGpuEncoderName(encoder, "h264"));

  if (encoder === "videotoolbox") {
    args.push(
      ...buildVideoToolboxRateControlArgs({
        width: GPU_PROBE_WIDTH,
        height: GPU_PROBE_HEIGHT,
        fps: 1,
        quality: 23,
      }),
    );
  }

  if (encoder === "amf") {
    args.push("-rc", "cqp", "-qp_i", "28", "-qp_p", "28");
  }

  args.push("-f", "null", "-");
  return args;
}

async function canUseGpuEncoder(encoder: ConcreteGpuEncoder): Promise<boolean> {
  const ffmpeg = spawn(getFfmpegBinary(), getProbeArgs(encoder), {
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  trackChildProcess(ffmpeg);
  const outcome = await new ManagedChildProcess(ffmpeg, {
    deadlineAtMs: Date.now() + GPU_PROBE_TIMEOUT_MS,
    terminationGraceMs: GPU_PROBE_KILL_GRACE_MS,
  }).wait();
  const usable = outcome.reason === "exit" && outcome.exitCode === 0;
  logGpuProbeFailure(encoder, {
    code: outcome.exitCode,
    signal: outcome.signal,
    stderr: outcome.stderr,
    error: outcome.error,
    timedOut: outcome.reason === "deadline",
  });
  return usable;
}

function logGpuProbeFailure(
  encoder: ConcreteGpuEncoder,
  result: {
    code?: number | null;
    error?: Error;
    signal?: NodeJS.Signals | null;
    stderr?: string;
    timedOut?: boolean;
  },
): void {
  if (!isGpuProbeDebugEnabled()) return;
  if (result.code === 0 && !result.error && !result.timedOut) return;

  const reason = result.error
    ? result.error.message
    : result.timedOut
      ? `timed out after ${GPU_PROBE_TIMEOUT_MS}ms`
      : `exit=${String(result.code)} signal=${String(result.signal ?? "")}`;
  const stderr = result.stderr?.trim();
  console.warn(`[gpuEncoder] ${encoder} probe failed: ${reason}${stderr ? `\n${stderr}` : ""}`);
}

function isGpuProbeDebugEnabled(): boolean {
  const value = process.env.HYPERFRAMES_DEBUG_GPU_PROBE;
  return value === "1" || value === "true";
}

// libx264 preset names (ultrafast/superfast/.../placebo) mapped to the
// equivalent NVENC p1..p7 preset. NVENC rejects libx264 names with
// AVERROR(EINVAL) ("Error applying encoder options: Invalid argument"),
// which surfaces as a generic "FFmpeg exited with code -22" — so callers
// that share a single `preset` field across CPU and GPU paths (e.g. the
// `draft`/`standard`/`high` quality tiers) must translate before passing
// the value to h264_nvenc / hevc_nvenc.
const NVENC_PRESET_MAP: Record<string, string> = {
  ultrafast: "p1",
  superfast: "p1",
  veryfast: "p2",
  faster: "p3",
  fast: "p4",
  medium: "p4",
  slow: "p5",
  slower: "p6",
  veryslow: "p7",
  placebo: "p7",
};

// QSV accepts most libx264 preset names but rejects `ultrafast`,
// `superfast`, and `placebo`. Map those to the nearest supported values.
const QSV_PRESET_MAP: Record<string, string> = {
  ultrafast: "veryfast",
  superfast: "veryfast",
  placebo: "veryslow",
};

/**
 * Translate a libx264-style `-preset` value to one accepted by the given
 * GPU encoder.
 *
 * - `nvenc`: libx264 names → `p1`..`p7`. Already-native `pN` values pass
 *   through unchanged. Unknown values fall back to `p4` (medium).
 * - `qsv`:  `ultrafast`/`superfast`/`placebo` → nearest supported name;
 *   everything else passes through.
 * - `videotoolbox`, `vaapi`, `amf`, `null`: no remap (they either ignore
 *   `-preset` entirely or accept the libx264 vocabulary).
 */
export function mapPresetForGpuEncoder(encoder: GpuEncoder, preset: string): string {
  switch (encoder) {
    case "nvenc":
      if (/^p[1-7]$/.test(preset)) return preset;
      return NVENC_PRESET_MAP[preset] ?? "p4";
    case "qsv":
      return QSV_PRESET_MAP[preset] ?? preset;
    default:
      return preset;
  }
}
