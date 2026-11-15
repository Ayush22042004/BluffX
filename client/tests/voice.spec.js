import { test, expect, chromium } from "@playwright/test";
import helper from "../../server/test/socket-client.cjs";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

function continuousTone() {
  const samples = 48000 * 8,
    wav = Buffer.alloc(44 + samples * 2);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(48000, 24);
  wav.writeUInt32LE(96000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    wav.writeInt16LE(
      Math.round(
        Math.sin((2 * Math.PI * 440 * i) / 48000) *
          [2500, 8000, 22000, 30000][Math.floor(i / 96000) % 4],
      ),
      44 + i * 2,
    );
  mkdirSync("tests/artifacts", { recursive: true });
  const file = resolve("tests/artifacts/voice-continuous-tone.wav");
  writeFileSync(file, wav);
  return file;
}

test("two browsers exchange real audio, mute, deafen, set volume and release microphones on leave", async () => {
  test.setTimeout(60000);
  const browser = await chromium.launch({
    channel: "chrome",
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${continuousTone()}`,
    ],
  });
  const host = helper.io("http://localhost:4020", {
    autoConnect: false,
    transports: ["websocket"],
  });
  try {
    await new Promise((resolve) => {
      host.once("server_ready", resolve);
      host.connect();
    });
    const room = await new Promise((resolve) =>
      host.emit("create_room", { name: "Voice Host", maxPlayers: 3 }, resolve),
    );
    const pages = [];
    for (const name of ["Voice Alice", "Voice Bob"]) {
      const context = await browser.newContext({
        permissions: ["microphone"],
        baseURL: "http://localhost:5180",
      });
      const page = await context.newPage();
      pages.push(page);
      await page.addInitScript((name) => {
        sessionStorage.setItem("bluffx:guest", "true");
        localStorage.setItem(
          "bluffx:profile",
          JSON.stringify({ name, avatar: 0 }),
        );
        window.__voicePCs = [];
        window.__voiceStreams = [];
        const Original = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends Original {
          constructor(...args) {
            super(...args);
            window.__voicePCs.push(this);
          }
        };
        const capture = navigator.mediaDevices.getUserMedia.bind(
          navigator.mediaDevices,
        );
        navigator.mediaDevices.getUserMedia = async (constraints) => {
          const s = await capture(constraints);
          window.__voiceStreams.push(s);
          return s;
        };
      }, name);
      await page.goto("/");
      await page
        .getByRole("button", { name: "Join Room", exact: true })
        .click();
      await page.getByLabel("Room code", { exact: true }).fill(room.roomId);
      await page
        .locator(".join-page form")
        .getByRole("button", { name: "Join Room", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Join Voice", exact: true })
        .click();
      await expect(
        page.getByRole("button", { name: "Unmute Mic", exact: true }),
      ).toBeVisible();
    }
    const [a, b] = pages;
    for (const width of [390, 1024, 1366]) {
      await a.setViewportSize({ width, height: 768 });
      const layout = await a.locator(".voice-panel").evaluate((panel) => {
        const box = panel.getBoundingClientRect();
        return [...panel.querySelectorAll("button, input")].every((control) => {
          if (
            !control.getClientRects().length ||
            control.closest("details:not([open])")
          )
            return true;
          const r = control.getBoundingClientRect();
          const inside =
            r.top >= box.top &&
            r.bottom <= box.bottom &&
            r.left >= box.left &&
            r.right <= box.right;
          return inside;
        });
      });
      expect(layout, `voice controls stay inside the panel at ${width}px`).toBe(
        true,
      );
    }
    for (const page of pages) {
      await expect(page.locator(".voice-members li")).toHaveCount(2);
      await expect
        .poll(() =>
          page.evaluate(() =>
            window.__voicePCs.some((pc) => pc.connectionState === "connected"),
          ),
        )
        .toBe(true);
      expect(
        await page.evaluate(() => window.__voiceStreams.length),
        "joining muted must not open a microphone",
      ).toBe(0);
      if (process.env.BLUFFX_TEST_TURN === "true") {
        expect(
          await page.evaluate(
            () =>
              window.__voicePCs.at(-1).getConfiguration().iceTransportPolicy,
          ),
        ).toBe("relay");
        const relay = await page.evaluate(async () => {
          const rows = [
            ...(await window.__voicePCs.at(-1).getStats()).values(),
          ];
          const pairId = rows.find(
            (s) => s.type === "transport",
          )?.selectedCandidatePairId;
          const pair = rows.find((s) => s.id === pairId);
          return rows.some(
            (s) =>
              (s.id === pair?.localCandidateId ||
                s.id === pair?.remoteCandidateId) &&
              s.candidateType === "relay",
          );
        });
        expect(relay, "actual selected audio route uses TURN").toBe(true);
      }
    }
    await a.getByRole("button", { name: "Unmute Mic", exact: true }).click();
    await expect
      .poll(() =>
        a.evaluate(
          () => window.__voiceStreams[0]?.getAudioTracks()[0]?.enabled,
        ),
      )
      .toBe(true);
    await expect(a.locator(".voice-mode")).toContainText("Audio stays live");
    const settings = await a.evaluate(() =>
      window.__voiceStreams[0].getAudioTracks()[0].getSettings(),
    );
    expect(settings.echoCancellation).toBe(false);
    expect(settings.noiseSuppression).toBe(false);
    expect(settings.autoGainControl).toBe(false);
    for (const page of pages) {
      const speaker = page
        .locator(".player-panel .player-row")
        .filter({ hasText: "Voice Alice" });
      await expect(speaker).toHaveClass(/voice-speaking/);
      await expect(speaker.locator(".speaking-badge")).toHaveText("Speaking");
      await expect(
        page
          .locator(".player-panel .player-row")
          .filter({ hasText: "Voice Bob" })
          .locator(".speaking-badge"),
      ).toHaveCount(0);
    }
    await b.setViewportSize({ width: 1440, height: 1000 });
    await b
      .locator(".player-panel")
      .screenshot({ path: "tests/artifacts/speaking-players-desktop.png" });
    await b
      .locator(".voice-panel")
      .screenshot({ path: "tests/artifacts/speaking-voice-desktop.png" });
    await expect(
      a.getByRole("radio", { name: "Headphones", exact: true }),
    ).toBeDisabled();
    const [capture, reception] = await Promise.all([
      a.evaluate(async () => {
        const track = window.__voiceStreams[0].getAudioTracks()[0];
        const connection = window.__voicePCs.at(-1);
        const checks = [];
        for (let i = 0; i < 12; i++) {
          await new Promise((resolve) => setTimeout(resolve, 250));
          checks.push(
            track.enabled &&
              track.readyState === "live" &&
              connection.connectionState === "connected",
          );
        }
        return checks.every(Boolean);
      }),
      b.evaluate(async () => {
        const samples = [];
        for (let i = 0; i < 6; i++) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          let bytes = 0;
          for (const pc of window.__voicePCs)
            for (const stat of (await pc.getStats()).values())
              if (stat.type === "inbound-rtp" && stat.kind === "audio")
                bytes += stat.bytesReceived || 0;
          samples.push(bytes);
        }
        return samples;
      }),
    ]);
    expect(capture, "meter updates never gate the live microphone").toBe(true);
    for (const page of pages) {
      expect(
        await page.evaluate(() =>
          window.__voicePCs
            .at(-1)
            .getTransceivers()
            .map((t) => t.currentDirection),
        ),
      ).toEqual(["sendrecv"]);
    }
    expect(reception.at(-1)).toBeGreaterThan(reception[0]);
    expect(
      reception.filter((n, i) => i > 0 && n > reception[i - 1]).length,
    ).toBeGreaterThanOrEqual(4);
    const sound = await b.evaluate(async () => {
      const audio = document.querySelector("audio");
      const context = new AudioContext();
      await context.resume();
      const source = context.createMediaStreamSource(audio.captureStream());
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const values = new Float32Array(2048),
        levels = [];
      for (let i = 0; i < 120; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        analyser.getFloatTimeDomainData(values);
        levels.push(
          Math.sqrt(values.reduce((n, v) => n + v * v, 0) / values.length),
        );
      }
      source.disconnect();
      await context.close();
      return { levels, paused: audio.paused };
    });
    console.log(
      JSON.stringify({
        playbackSamples: sound.levels.length,
        silentSamples: sound.levels.filter((n) => n < 0.005).length,
      }),
    );
    expect(sound.paused).toBe(false);
    expect(sound.levels.filter((n) => n < 0.005)).toHaveLength(0);
    expect(
      await b.evaluate(() => window.__voiceStreams.length),
      "the receiving tab stays listen-only",
    ).toBe(0);
    // Exercise recovery with a synthetic disconnected-state event, keeping real
    // peer connections alive so an actual ICE restart/answer exchange can complete.
    const offerer =
      (await a.evaluate(
        () => window.__voicePCs.at(-1).localDescription.type,
      )) === "offer"
        ? a
        : b;
    await offerer.evaluate(() => {
      const pc = window.__voicePCs.at(-1),
        create = pc.createOffer.bind(pc);
      window.__iceRestarts = 0;
      pc.createOffer = async (options) => {
        if (options?.iceRestart) window.__iceRestarts++;
        return create(options);
      };
      Object.defineProperty(pc, "connectionState", {
        configurable: true,
        get: () => "disconnected",
      });
      pc.onconnectionstatechange();
    });
    await expect
      .poll(() => offerer.evaluate(() => window.__iceRestarts), {
        timeout: 10000,
      })
      .toBe(1);
    await offerer.evaluate(() => {
      delete window.__voicePCs.at(-1).connectionState;
    });
    for (const page of pages) {
      await expect
        .poll(() =>
          page.evaluate(() => window.__voicePCs.at(-1).connectionState),
        )
        .toBe("connected");
      expect(await page.evaluate(() => window.__voicePCs.length)).toBe(1);
    }
    await expect(
      a.getByLabel("Noise reduction", { exact: true }),
    ).not.toBeChecked();
    await expect(
      a.getByLabel("Noise reduction", { exact: true }),
    ).toBeDisabled();
    expect(
      await a.evaluate(
        () => window.__voiceStreams[0]?.getAudioTracks()[0]?.enabled,
      ),
    ).toBe(true);
    await expect
      .poll(() =>
        b.evaluate(async () => {
          let bytes = 0;
          for (const pc of window.__voicePCs)
            for (const stat of (await pc.getStats()).values())
              if (stat.type === "inbound-rtp" && stat.kind === "audio")
                bytes += stat.bytesReceived || 0;
          return bytes;
        }),
      )
      .toBeGreaterThan(0);
    await b.getByRole("button", { name: "Deafen", exact: true }).click();
    await expect(
      b.getByRole("button", { name: "Undeafen", exact: true }),
    ).toBeVisible();
    const volume = b.getByLabel("Volume for Voice Alice");
    const slider = await volume.boundingBox();
    await b.mouse.click(slider.x + 1, slider.y + slider.height / 2);
    await expect(volume).toHaveValue("0");
    expect(await b.evaluate(() => document.querySelector("audio").volume)).toBe(
      0,
    );
    await b.mouse.click(
      slider.x + slider.width - 1,
      slider.y + slider.height / 2,
    );
    await expect(volume).toHaveValue("100");
    expect(await b.evaluate(() => document.querySelector("audio").volume)).toBe(
      1,
    );
    await volume.press("Home");
    await expect(volume).toHaveValue("0");
    await volume.press("End");
    await expect(volume).toHaveValue("100");
    await volume.fill("35");
    expect(await b.evaluate(() => document.querySelector("audio").volume)).toBe(
      0.35,
    );
    await a.getByRole("button", { name: "Mute Mic", exact: true }).click();
    await expect(
      b
        .locator(".player-panel .player-row")
        .filter({ hasText: "Voice Alice" })
        .locator(".speaking-badge"),
    ).toHaveCount(0);
    await expect
      .poll(() =>
        a.evaluate(
          () => window.__voiceStreams[0]?.getAudioTracks()[0]?.enabled,
        ),
      )
      .toBe(false);
    expect(
      await a.evaluate(() =>
        window.__voiceStreams[0]
          .getTracks()
          .every((t) => t.readyState === "ended"),
      ),
    ).toBe(true);
    await a.getByLabel("Noise reduction", { exact: true }).check();
    await expect(
      a.getByLabel("Noise reduction", { exact: true }),
    ).toBeChecked();
    // Reverse direction without ever opening the same microphone in both contexts.
    await b.getByRole("radio", { name: "Speakers", exact: true }).check();
    await b.getByRole("button", { name: "Unmute Mic", exact: true }).click();
    await expect
      .poll(() =>
        b.evaluate(
          () => window.__voiceStreams[0]?.getAudioTracks()[0]?.enabled,
        ),
      )
      .toBe(true);
    expect(
      await b.evaluate(
        () =>
          window.__voiceStreams[0].getAudioTracks()[0].getSettings()
            .echoCancellation,
      ),
    ).toBe(true);
    await expect
      .poll(() =>
        a.evaluate(async () => {
          let energy = 0;
          for (const stat of (
            await window.__voicePCs.at(-1).getStats()
          ).values())
            if (stat.type === "inbound-rtp" && stat.kind === "audio")
              energy += stat.totalAudioEnergy || 0;
          return energy;
        }),
      )
      .toBeGreaterThan(0);
    await b.getByRole("button", { name: "Mute Mic", exact: true }).click();
    await expect
      .poll(() =>
        b.evaluate(() =>
          window.__voiceStreams[0]
            .getTracks()
            .every((t) => t.readyState === "ended"),
        ),
      )
      .toBe(true);
    await a.getByRole("button", { name: "Leave Voice", exact: true }).click();
    await expect(b.locator(".voice-members li")).toHaveCount(1);
    expect(
      await a.evaluate(() =>
        window.__voiceStreams[0]
          .getTracks()
          .every((t) => t.readyState === "ended"),
      ),
    ).toBe(true);
    await a.getByRole("button", { name: "Join Voice", exact: true }).click();
    await expect(b.locator(".voice-members li")).toHaveCount(2);
    await expect
      .poll(() => b.evaluate(() => window.__voicePCs.at(-1)?.connectionState))
      .toBe("connected");
    await a.getByRole("button", { name: "Leave Voice", exact: true }).click();
    await b.reload();
    await expect(
      b.getByRole("button", { name: "Join Voice", exact: true }),
    ).toBeVisible();
    expect(await b.evaluate(() => window.__voiceStreams.length)).toBe(0);
    await b.evaluate(() => {
      navigator.mediaDevices.getUserMedia = async () => {
        throw new DOMException("Denied", "NotAllowedError");
      };
    });
    await b.getByRole("button", { name: "Join Voice", exact: true }).click();
    await b.getByRole("button", { name: "Unmute Mic", exact: true }).click();
    await expect(b.locator(".voice-error")).toContainText(
      "Microphone permission was denied",
    );
    await expect(
      b.getByRole("button", { name: "Unmute Mic", exact: true }),
    ).toBeEnabled();
  } finally {
    host.disconnect();
    await browser.close();
  }
});
