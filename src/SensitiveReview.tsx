import type { SensitiveFinding, SensitiveReport } from "../common/ipc";
import { sourceLabel } from "../common/sensitive";

const SEVERITY_LABEL: Record<SensitiveFinding["severity"], string> = {
  high: "High risk",
  medium: "Possibly sensitive",
  low: "Low confidence",
};

function headline(report: SensitiveReport): string {
  const n = report.totalFindings;
  return `Found ${n} potentially sensitive ${n === 1 ? "detail" : "details"} before sending`;
}

/**
 * Shown when the on-device pre-send scan flags something in a recording. Nothing
 * has left the machine at this point — the user reviews the (already-redacted)
 * findings and chooses whether to continue. Values are masked and context is
 * redacted upstream in the scanner; this component never sees a raw secret.
 */
export function SensitiveReview({
  report,
  busy,
  onCancel,
  onProceed,
}: {
  report: SensitiveReport;
  busy?: boolean;
  onCancel: () => void;
  onProceed: () => void;
}) {
  return (
    <section className="sensitive-review" role="alert" aria-live="assertive">
      <header className="sensitive-review-head">
        <span className="sensitive-review-icon" aria-hidden="true">
          ⚠
        </span>
        <div>
          <strong>{headline(report)}</strong>
          <p className="sensitive-review-sub">
            This check ran on your computer — nothing has been sent to GitHub Copilot yet.
            Review what was flagged, then decide whether to continue.
          </p>
        </div>
      </header>

      <ul className="sensitive-list">
        {report.findings.map((f, i) => (
          <li key={`${f.source}-${f.label}-${i}`} className="sensitive-item">
            <span
              className={`sensitive-dot sev-${f.severity}`}
              title={SEVERITY_LABEL[f.severity]}
              aria-hidden="true"
            />
            <div className="sensitive-item-body">
              <div className="sensitive-item-head">
                <span className="sensitive-label">{f.label}</span>
                <span className="sensitive-source">{sourceLabel(f.source)}</span>
                {f.occurrences > 1 && <span className="sensitive-count">×{f.occurrences}</span>}
              </div>
              <code className="sensitive-snippet">{f.snippet}</code>
            </div>
          </li>
        ))}
      </ul>

      <p className="sensitive-caveat">
        This scans text only — window titles, URLs, clipboard, terminal commands, notes, and
        voice. Sensitive details that only appear in screenshots aren&apos;t detected here, so
        review the recording itself too.
      </p>

      <div className="sensitive-actions">
        <button className="linky" onClick={onCancel} disabled={busy}>
          Don&apos;t send
        </button>
        <button className="record-cta danger" onClick={onProceed} disabled={busy}>
          {busy ? "Sending…" : "Analyze anyway"}
        </button>
      </div>
    </section>
  );
}
