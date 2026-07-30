import {
  BrowserWindow,
  dialog,
  ipcMain,
  shell,
  type OpenDialogOptions,
  type SaveDialogOptions,
} from "electron";
import os from "node:os";
import path from "node:path";

import type {
  AnalysisEditInput,
  AnalysisFeedbackInput,
  AnalyzeOptions,
  AnalyzeResult,
  AutomationBuildInput,
  AutomationCreateResult,
  AutomationPlanResult,
  DebugBundleResult,
  DeleteSessionResult,
  MicrophoneSettingsResult,
  SkillBuildInput,
  SkillCreateResult,
  SkillPlacement,
  SkillPlanResult,
} from "../common/ipc";
import { IPC } from "../common/ipc";
import type { AutomationPlan } from "../common/automation";
import type { NarrationLanguage } from "../common/narration";
import type { SkillPlan } from "../common/skill";
import { AutomationBuilder, loadPersistedAutomation } from "./automationbuilder/builder";
import { openCopilotSignIn } from "./copilot-signin";
import { buildDebugInfo, writeDebugBundle } from "./debug-bundle";
import { Describer, loadPersistedAnalysis } from "./describer/describer";
import { runDoctor } from "./doctor";
import { createLogger } from "./logger";
import type { AudioRecorder } from "./audio/recorder";
import type { NarrationManager } from "./narration/manager";
import type { RecorderController } from "./recorder/controller";
import { isValidSessionId } from "./recorder/session-store";
import { scanSessionForSensitive } from "./sensitive/scanner";
import { deleteSession, listSessions } from "./sessions";
import { loadPersistedSkill, SkillBuilder, type SkillTarget } from "./skillbuilder/builder";

const log = createLogger("IPC");

/** Wire the renderer-facing invoke channels to the recorder, describer, builders + doctor. */
export function registerIpc(
  recorder: RecorderController,
  describer: Describer,
  builder: SkillBuilder,
  automationBuilder: AutomationBuilder,
  narration: NarrationManager,
  microphones: AudioRecorder,
): void {
  ipcMain.handle(IPC.stop, () => recorder.stop());
  ipcMain.handle(IPC.discard, () => recorder.discard());
  ipcMain.handle(IPC.microphone, (_event, enabled: boolean) =>
    recorder.setMicrophoneEnabled(enabled, microphones.effectiveDeviceId()),
  );
  ipcMain.handle(IPC.microphoneSettings, () => microphones.settings());
  ipcMain.handle(
    IPC.microphoneNarration,
    async (_event, enabled: boolean): Promise<MicrophoneSettingsResult> => {
      if (typeof enabled !== "boolean") {
        return {
          ok: false,
          status: microphones.settings(),
          error: "Invalid narration preference.",
        };
      }
      if (recorder.state === "recording") {
        return {
          ok: false,
          status: microphones.settings(),
          error: "Choose the next recording's narration state after this recording ends.",
        };
      }
      return microphones.setNarrationEnabled(enabled);
    },
  );
  ipcMain.handle(
    IPC.microphoneDevice,
    async (_event, deviceId: string): Promise<MicrophoneSettingsResult> => {
      if (typeof deviceId !== "string" || !deviceId) {
        return {
          ok: false,
          status: microphones.settings(),
          error: "Invalid microphone selection.",
        };
      }
      const previousDeviceId = microphones.effectiveDeviceId();
      const selected = await microphones.selectDevice(deviceId);
      if (
        !selected.ok ||
        recorder.status().microphone.state !== "on" ||
        microphones.effectiveDeviceId() === previousDeviceId
      ) {
        return selected;
      }
      const switched = await recorder.setMicrophoneDevice(
        microphones.effectiveDeviceId(),
      );
      if (!switched.ok) {
        return {
          ok: false,
          status: microphones.settings(),
          error: switched.error ?? "Could not switch microphones.",
        };
      }
      return { ok: true, status: microphones.settings() };
    },
  );
  ipcMain.handle(IPC.narrationLanguage, (_event, language: NarrationLanguage) =>
    recorder.setNarrationLanguage(language),
  );
  ipcMain.handle(IPC.status, () => recorder.status());
  ipcMain.handle(IPC.marker, (_event, note: string) => recorder.marker(note));
  ipcMain.handle(IPC.doctor, () => runDoctor());
  ipcMain.handle(IPC.copilotSignIn, () => openCopilotSignIn());
  ipcMain.handle(IPC.narrationStatus, () => narration.status());
  ipcMain.handle(IPC.narrationDownload, () => narration.downloadModel());
  ipcMain.handle(IPC.narrationTranscribe, (_event, sessionId: string) =>
    narration.transcribeSession(sessionId),
  );

  const resolveSessionId = (sessionId?: string): string | null => {
    if (sessionId) return sessionId;
    const dir = recorder.lastSessionDir();
    return dir ? path.basename(dir) : null;
  };

  ipcMain.handle(
    IPC.analyze,
    async (_event, sessionId?: string, options?: AnalyzeOptions): Promise<AnalyzeResult> => {
      const id = resolveSessionId(sessionId);
      if (!id) return { ok: false, error: "No completed session to analyze yet." };
      if (!isValidSessionId(id)) return { ok: false, error: "Unknown session." };
      // Transcribe any recorded voice first so analysis never silently runs without
      // the user's spoken intent. Downloads the model on first use. Best-effort: a
      // failure here falls through to analyzing without voice (the error is surfaced
      // via the narration status affordance and the audio stays saved).
      await narration.ensureTranscribedForAnalysis(id);
      // On-device pre-send gate: scan exactly the text that would go to GitHub
      // Copilot for secrets/credentials/PII. If anything is flagged and the user
      // hasn't acknowledged it, hold the analysis and return the (redacted) review
      // for confirmation — nothing leaves the machine. Best-effort: a scan failure
      // must never block a legitimate analysis.
      if (!options?.acknowledgeSensitive) {
        try {
          const review = scanSessionForSensitive(id);
          if (review.totalFindings > 0) return { ok: false, review };
        } catch (err) {
          log.warn("sensitive scan failed; proceeding:", err instanceof Error ? err.message : err);
        }
      }
      try {
        const analysis = await describer.analyze(id);
        return { ok: true, analysis };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn("analyze failed:", error);
        return { ok: false, error };
      }
    },
  );

  ipcMain.handle(
    IPC.analyzeFeedback,
    async (_event, input: AnalysisFeedbackInput): Promise<AnalyzeResult> => {
      if (!isValidSessionId(input?.sessionId)) return { ok: false, error: "Unknown session." };
      try {
        const analysis = await describer.feedback(input.sessionId, {
          overall: input.overall,
          steps: input.steps ?? [],
        });
        return { ok: true, analysis };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn("feedback failed:", error);
        return { ok: false, error };
      }
    },
  );

  ipcMain.handle(IPC.getAnalysis, (_event, sessionId: string) =>
    isValidSessionId(sessionId) ? loadPersistedAnalysis(sessionId) : null,
  );

  ipcMain.handle(IPC.updateAnalysis, async (_event, input: AnalysisEditInput): Promise<AnalyzeResult> => {
    if (!isValidSessionId(input?.sessionId)) return { ok: false, error: "Unknown session." };
    try {
      const analysis = await describer.edit(input.sessionId, {
        title: input.title,
        intent: input.intent,
        steps: input.steps,
      });
      return { ok: true, analysis };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn("update failed:", error);
      return { ok: false, error };
    }
  });

  ipcMain.handle(IPC.cancelAnalysis, async (_event, sessionId: string) => {
    if (isValidSessionId(sessionId)) await describer.cancel(sessionId);
    return { ok: true };
  });

  ipcMain.handle(IPC.listSessions, () => listSessions());

  ipcMain.handle(IPC.deleteSession, async (_event, sessionId: string): Promise<DeleteSessionResult> => {
    if (!isValidSessionId(sessionId)) return { ok: false, error: "Unknown session." };
    if (recorder.status().sessionId === sessionId) {
      return { ok: false, error: "You can't delete a recording while it's still in progress." };
    }
    if (describer.isAnalyzing(sessionId)) {
      return { ok: false, error: "This recording is being analyzed. Cancel that first, then delete." };
    }
    if (narration.isBusyWith(sessionId)) {
      return { ok: false, error: "This recording is being transcribed. Wait for that to finish before deleting it." };
    }
    if (builder.isBuilding(sessionId)) {
      return { ok: false, error: "This recording is being turned into a skill. Cancel that first, then delete." };
    }
    if (automationBuilder.isBuilding(sessionId)) {
      return {
        ok: false,
        error: "This recording is being turned into an automation. Cancel that first, then delete.",
      };
    }
    try {
      await describer.forget(sessionId); // release any idle agent holding the folder
      await builder.forget(sessionId);
      await automationBuilder.forget(sessionId);
      await deleteSession(sessionId);
      recorder.forgetSession(sessionId); // clear the "last completed" pointer if it was this one
      return { ok: true };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn("delete failed:", error);
      return { ok: false, error };
    }
  });

  ipcMain.handle(
    IPC.exportDebugBundle,
    async (event, sessionId: string): Promise<DebugBundleResult> => {
      if (!isValidSessionId(sessionId)) return { ok: false, error: "Unknown session." };
      // The session folder is still being written while it records; refuse to zip
      // a moving target. Analyzing/building are read-only, so those are allowed.
      if (recorder.status().sessionId === sessionId) {
        return {
          ok: false,
          error: "You can't download details while this recording is still in progress.",
        };
      }
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const opts: SaveDialogOptions = {
        title: "Download session details",
        defaultPath: path.join(
          os.homedir(),
          "Downloads",
          `skill-recorder-debug-${sessionId}.zip`,
        ),
        filters: [{ name: "Zip archive", extensions: ["zip"] }],
      };
      const result = win
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts);
      if (result.canceled || !result.filePath) return { ok: false, canceled: true };
      try {
        await writeDebugBundle(sessionId, result.filePath, buildDebugInfo(sessionId));
        shell.showItemInFolder(result.filePath); // hand the file to the user to attach
        return { ok: true, path: result.filePath };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn("debug bundle failed:", error);
        return { ok: false, error };
      }
    },
  );

  ipcMain.handle(IPC.buildSkill, async (_event, input: SkillBuildInput): Promise<SkillPlanResult> => {
    if (!isValidSessionId(input?.sessionId)) return { ok: false, error: "Unknown session." };
    try {
      const plan = await builder.build(input);
      return { ok: true, plan };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn("build skill failed:", error);
      return { ok: false, error };
    }
  });

  ipcMain.handle(
    IPC.createSkill,
    async (
      event,
      sessionId: string,
      plan?: SkillPlan,
      placement: SkillPlacement = "install",
    ): Promise<SkillCreateResult> => {
      if (!isValidSessionId(sessionId)) return { ok: false, error: "Unknown session." };
      try {
        let target: SkillTarget = { kind: "install" };
        if (placement === "export") {
          // Export == download: let the user pick a destination folder; we drop a
          // ready-to-use <name>/SKILL.md inside it. A dismissed dialog is a cancel, not an error.
          const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
          const opts: OpenDialogOptions = {
            title: "Export skill to folder",
            defaultPath: path.join(os.homedir(), "Downloads"),
            properties: ["openDirectory", "createDirectory"],
          };
          const result = win
            ? await dialog.showOpenDialog(win, opts)
            : await dialog.showOpenDialog(opts);
          if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true };
          target = { kind: "export", dir: result.filePaths[0] };
        }
        const { skill, path: file } = await builder.create(sessionId, plan, target);
        return { ok: true, skill, path: file, placement };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn("create skill failed:", error);
        return { ok: false, error };
      }
    },
  );

  ipcMain.handle(IPC.getSkill, (_event, sessionId: string) =>
    isValidSessionId(sessionId) ? loadPersistedSkill(sessionId) : null,
  );

  ipcMain.handle(IPC.cancelSkill, async (_event, sessionId: string) => {
    if (isValidSessionId(sessionId)) await builder.cancel(sessionId);
    return { ok: true };
  });

  ipcMain.handle(IPC.revealSkill, (_event, sessionId: string) => {
    if (!isValidSessionId(sessionId)) return { ok: false };
    const skill = loadPersistedSkill(sessionId);
    if (skill?.exportedPath) shell.showItemInFolder(skill.exportedPath);
    return { ok: true };
  });

  ipcMain.handle(
    IPC.buildAutomation,
    async (_event, input: AutomationBuildInput): Promise<AutomationPlanResult> => {
      if (!isValidSessionId(input?.sessionId)) return { ok: false, error: "Unknown session." };
      try {
        const plan = await automationBuilder.build(input);
        return { ok: true, plan };
      } catch (err) {
        const error = err instanceof Error ? err.message : String(err);
        log.warn("build automation failed:", error);
        return { ok: false, error };
      }
    },
  );

  ipcMain.handle(IPC.createAutomation, async (_event, sessionId: string, plan?: AutomationPlan): Promise<AutomationCreateResult> => {
    if (!isValidSessionId(sessionId)) return { ok: false, error: "Unknown session." };
    try {
      const { automation, path: file } = await automationBuilder.create(sessionId, plan);
      return { ok: true, automation, path: file };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn("create automation failed:", error);
      return { ok: false, error };
    }
  });

  ipcMain.handle(IPC.getAutomation, (_event, sessionId: string) =>
    isValidSessionId(sessionId) ? loadPersistedAutomation(sessionId) : null,
  );

  ipcMain.handle(IPC.cancelAutomation, async (_event, sessionId: string) => {
    if (isValidSessionId(sessionId)) await automationBuilder.cancel(sessionId);
    return { ok: true };
  });

  ipcMain.handle(IPC.revealAutomation, (_event, sessionId: string) => {
    if (!isValidSessionId(sessionId)) return { ok: false };
    const automation = loadPersistedAutomation(sessionId);
    if (automation?.exportedPath) shell.showItemInFolder(automation.exportedPath);
    return { ok: true };
  });
}
