import { useEffect, useRef } from "react";

/**
 * Plain-language disclosure of what the recorder captures, where it is stored,
 * and what leaves the machine on analysis. Every claim here is grounded in the
 * actual collectors and describer behavior, so it must be kept in sync with them.
 */
export function WhatsRecorded({
  onClose,
  onReviewed,
}: {
  onClose: () => void;
  onReviewed: () => void;
}) {
  const sheetRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    sheetRef.current?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div
        ref={sheetRef}
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-recorded-title"
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <header className="sheet-head">
          <span className="sheet-icon" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none">
              <path
                d="M10 2.5 4 4.8v4.3c0 3.4 2.4 6.2 6 7.4 3.6-1.2 6-4 6-7.4V4.8L10 2.5Z"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
              <path
                d="m7.4 9.8 1.9 1.9 3.4-3.6"
                stroke="currentColor"
                strokeWidth="1.4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </span>
          <h2 id="whats-recorded-title">What's recorded</h2>
        </header>

        <p className="sheet-lead">
          This tool records your screen and activity so it can turn what you did into a reusable
          skill. Here is exactly what it captures and what leaves your computer.
        </p>

        <section className="sheet-block">
          <h3>While you're recording</h3>
          <p className="sheet-note">Only between Start and Stop.</p>
          <ul>
            <li>Which apps you switch to, and their window and document titles.</li>
            <li>Web addresses of the pages you open.</li>
            <li>A short preview of text you copy, up to 120 characters.</li>
            <li>A silent video of your screen at a low frame rate.</li>
          </ul>
          <p className="sheet-caution">
            Do not type, paste, display, copy, or narrate passwords, access tokens, API keys,
            credentials, secrets, or other sensitive or confidential information. Anything visible
            on screen can appear in the recording, and copied text previews and narration are
            captured too.
          </p>
        </section>

        <section className="sheet-block">
          <h3>Voice narration (only if you turn it on)</h3>
          <p className="sheet-note">
            Off by default. Choose the initial state and microphone with Narrate, then use the
            floating recording bar.
          </p>
          <ul>
            <li>
              Enabling Narrate briefly opens and releases the microphone so the app can request
              permission and show the available inputs. No audio is saved during this check.
            </li>
            <li>Your microphone audio is saved only while it is on and a recording is running.</li>
            <li>
              Turning the microphone off ends that voice segment and releases the device. Turning it
              on again, or switching inputs, starts a new segment linked to the same recording
              timeline.
            </li>
            <li>
              The recording can be turned into text on this computer using an on-device model. The
              transcript stays in the language you select from Whisper's 99 supported choices. The
              first transcription needs a one-time ~252 MB download that you choose when to start.
            </li>
            <li>Leave Narrate and the recording-bar microphone off and no microphone is opened.</li>
          </ul>
        </section>

        <section className="sheet-block">
          <h3>Where it's stored</h3>
          <ul>
            <li>Everything is saved on this computer, in the app's own session folder.</li>
            <li>Recordings stay until you delete them. You can delete any recording from Sessions.</li>
          </ul>
        </section>

        <section className="sheet-block">
          <h3>What's sent for analysis</h3>
          <ul>
            <li>Nothing leaves your computer while you record.</li>
            <li>
              When you choose Analyze, the event timeline—including window and document titles,
              URLs, and clipboard previews—plus extracted screen images and narration text (if
              recorded) are sent to GitHub&apos;s cloud service and processed by GitHub Copilot.
            </li>
          </ul>
        </section>

        <section className="sheet-block">
          <h3>Advanced protection (only if you turn it on)</h3>
          <p className="sheet-note">
            Off by default. Turn it on with Advanced protection in the recorder; it needs a
            one-time download.
          </p>
          <ul>
            <li>
              Before anything is sent, it reads the text in your screen images on-device and blurs
              sensitive matches—keys, emails, ID numbers—out of the images, the same scan already
              run over recorded text.
            </li>
            <li>
              It all runs on this computer and never blocks Analyze. If the model is not ready,
              screen images are held back rather than sent unblurred.
            </li>
          </ul>
          <p className="sheet-caution">
            No method is 100% effective—it can miss details or mask the wrong ones. Treat it as a
            safety net, not a guarantee, and still avoid capturing anything secret.
          </p>
        </section>

        <section className="sheet-block">
          <h3>What it never does</h3>
          <ul>
            <li>It does not log your keystrokes.</li>
            <li>It only captures while a recording is running. Nothing runs in the background.</li>
          </ul>
        </section>

        <button className="sheet-close" onClick={onReviewed}>
          Got it
        </button>
      </div>
    </div>
  );
}
