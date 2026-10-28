import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getCachedGpuEncoder,
  getCompiledGpuEncoders,
  getGpuEncoderName,
  getProbeArgs,
  gpuProbeKey,
  keepGpuEncoder,
  keptGpuEncoder,
  mapPresetForGpuEncoder,
  resetCachedGpuEncoder,
  selectUsableGpuEncoder,
} from "./gpuEncoder.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("getCompiledGpuEncoders", () => {
  it("recognizes AMD AMF in FFmpeg's encoder list", () => {
    expect(
      getCompiledGpuEncoders(`
 V....D h264_nvenc           NVIDIA NVENC H.264 encoder
 V....D h264_amf             AMD AMF H.264 Encoder
 V....D h264_qsv             H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10 (Intel Quick Sync Video)
`),
    ).toEqual(["nvenc", "qsv", "amf"]);
  });
});

describe("selectUsableGpuEncoder", () => {
  it("runs probe checks concurrently while preserving candidate priority", async () => {
    vi.useFakeTimers();
    const started: string[] = [];
    const usable = selectUsableGpuEncoder(["nvenc", "amf"], async (encoder) => {
      started.push(encoder);
      await new Promise((resolve) => setTimeout(resolve, encoder === "nvenc" ? 50 : 1));
      return true;
    });

    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual(["nvenc", "amf"]);

    await vi.advanceTimersByTimeAsync(49);
    expect(await usable).toBe("nvenc");
  });

  it("falls through from compiled-but-unusable NVENC to usable AMD AMF", async () => {
    const usable = await selectUsableGpuEncoder(["nvenc", "amf"], async (encoder) => {
      return encoder === "amf";
    });

    expect(usable).toBe("amf");
  });

  it("treats rejected probe checks as unusable", async () => {
    const usable = await selectUsableGpuEncoder(["nvenc", "amf"], async (encoder) => {
      if (encoder === "nvenc") {
        throw new Error("driver probe failed");
      }
      return encoder === "amf";
    });

    expect(usable).toBe("amf");
  });
});

describe("getGpuEncoderName", () => {
  it("maps AMD AMF to FFmpeg's h264 and hevc encoder names", () => {
    expect(getGpuEncoderName("amf", "h264")).toBe("h264_amf");
    expect(getGpuEncoderName("amf", "h265")).toBe("hevc_amf");
  });
});

describe("mapPresetForGpuEncoder", () => {
  describe("nvenc", () => {
    it.each([
      ["ultrafast", "p1"],
      ["superfast", "p1"],
      ["veryfast", "p2"],
      ["faster", "p3"],
      ["fast", "p4"],
      ["medium", "p4"],
      ["slow", "p5"],
      ["slower", "p6"],
      ["veryslow", "p7"],
      ["placebo", "p7"],
    ])("maps libx264 preset %s to NVENC %s", (input, expected) => {
      expect(mapPresetForGpuEncoder("nvenc", input)).toBe(expected);
    });

    it.each(["p1", "p2", "p3", "p4", "p5", "p6", "p7"])(
      "passes NVENC-native preset %s through unchanged",
      (preset) => {
        expect(mapPresetForGpuEncoder("nvenc", preset)).toBe(preset);
      },
    );

    it("falls back to p4 for unknown preset values", () => {
      expect(mapPresetForGpuEncoder("nvenc", "nonsense")).toBe("p4");
    });
  });

  describe("qsv", () => {
    it.each([
      ["ultrafast", "veryfast"],
      ["superfast", "veryfast"],
      ["placebo", "veryslow"],
    ])("rewrites libx264-only preset %s to QSV-supported %s", (input, expected) => {
      expect(mapPresetForGpuEncoder("qsv", input)).toBe(expected);
    });

    it.each(["veryfast", "faster", "fast", "medium", "slow", "slower", "veryslow"])(
      "passes supported preset %s through unchanged",
      (preset) => {
        expect(mapPresetForGpuEncoder("qsv", preset)).toBe(preset);
      },
    );
  });

  describe("other encoders", () => {
    it.each(["videotoolbox", "vaapi", "amf"] as const)(
      "passes preset through unchanged for %s",
      (encoder) => {
        expect(mapPresetForGpuEncoder(encoder, "medium")).toBe("medium");
        expect(mapPresetForGpuEncoder(encoder, "ultrafast")).toBe("ultrafast");
      },
    );

    it("passes preset through unchanged when encoder is null (CPU)", () => {
      expect(mapPresetForGpuEncoder(null, "ultrafast")).toBe("ultrafast");
    });
  });
});

describe("getProbeArgs", () => {
  it("uses 320x240 probe dimensions for all GPU encoders", () => {
    const encoders = ["nvenc", "videotoolbox", "vaapi", "qsv", "amf"] as const;
    for (const encoder of encoders) {
      const args = getProbeArgs(encoder);
      expect(args).toContain("color=size=320x240:rate=1:duration=1");
    }
  });

  it("probes VideoToolbox with the same supported bitrate option as production", () => {
    const args = getProbeArgs("videotoolbox");

    expect(args).not.toContain("-q:v");
    expect(args[args.indexOf("-b:v") + 1]).toBe("1M");
    expect(args[args.indexOf("-allow_sw") + 1]).toBe("1");
  });
});

describe("the kept GPU encoder probe", () => {
  const scratch = () => mkdtempSync(join(tmpdir(), "hf-gpu-probe-"));
  /** A file standing in for an FFmpeg build: it cannot run, so any probe of it finds no encoder. */
  const fakeFfmpeg = (dir: string) => {
    const path = join(dir, "ffmpeg");
    writeFileSync(path, "not ffmpeg");
    return path;
  };

  afterEach(() => {
    resetCachedGpuEncoder();
    vi.unstubAllEnvs();
  });

  it("keys on the FFmpeg build, and has no key for a bare name PATH resolves", () => {
    const ffmpeg = fakeFfmpeg(scratch());
    const before = gpuProbeKey(ffmpeg);
    expect(before).not.toBeNull();
    expect(gpuProbeKey("ffmpeg")).toBeNull();
    utimesSync(ffmpeg, new Date(2020, 0, 1), new Date(2020, 0, 1));
    expect(gpuProbeKey(ffmpeg)).not.toBe(before);
  });

  it("answers from a kept probe of the same build, and not from a stale, other or unknown one", () => {
    const dir = scratch();
    const file = join(dir, "kept.json");
    const ffmpeg = fakeFfmpeg(dir);
    const key = gpuProbeKey(ffmpeg)!;
    keepGpuEncoder(file, ffmpeg, key, null, 1_000);
    expect(keptGpuEncoder(file, ffmpeg, key, 2_000)).toBeNull();
    expect(keptGpuEncoder(file, ffmpeg, "another build", 2_000)).toBeUndefined();
    expect(keptGpuEncoder(file, ffmpeg, key, 1_000 + 8 * 24 * 60 * 60 * 1000)).toBeUndefined();
    writeFileSync(file, JSON.stringify({ [ffmpeg]: { key, encoder: "cuda", at: 1_000 } }));
    expect(keptGpuEncoder(file, ffmpeg, key, 2_000)).toBeUndefined();
  });

  it("a render reads the machine's kept answer instead of probing, and asks once however many encoders wait", async () => {
    const dir = scratch();
    const file = join(dir, "kept.json");
    const ffmpeg = fakeFfmpeg(dir);
    vi.stubEnv("HYPERFRAMES_FFMPEG_PATH", ffmpeg);
    keepGpuEncoder(file, ffmpeg, gpuProbeKey(ffmpeg)!, "videotoolbox");
    // A probe of the stand-in finds nothing, so videotoolbox can only come from the kept answer.
    const first = getCachedGpuEncoder(file);
    expect(getCachedGpuEncoder(file)).toBe(first);
    expect(await first).toBe("videotoolbox");
  });

  it("keeps nothing when FFmpeg could not list its encoders", async () => {
    const dir = scratch();
    const file = join(dir, "kept.json");
    vi.stubEnv("HYPERFRAMES_FFMPEG_PATH", fakeFfmpeg(dir));
    expect(await getCachedGpuEncoder(file)).toBeNull();
    expect(() => readFileSync(file)).toThrow();
  });
});
