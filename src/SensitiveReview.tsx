import type { SensitiveFinding, SensitiveReport } from "../common/ipc";
import { sourceLabel } from "../common/sensitive";

const SEVERITY_LABEL: Record<SensitiveFinding["severity"], string> = {
  high: "High risk",
  medium: "Possibly sensitive",
  low: "Low confidence",
};

function headline(report: SensitiveReport): string {
  const n = report.totalFindings;
  return `Redacted ${n} potentially sensitive ${n === 1 ? "detail" : "details"} before sending`;
}

/**
 * Informational, non-blocking summary shown after an analysis when the on-device
 * pre-send scan masked something. The values were redacted on this machine BEFORE
 * anything was sent to GitHub Copilot — the analysis already ran on the masked
 * text. Values are masked and context is redacted upstream in the scanner; this
 * component never sees a raw secret. The user can only dismiss it.
 */
export function SensitiveReview({
  report,
  onDismiss,
}: {
  report: SensitiveReport;
  onDismiss: () => void;
}) {
  return (
    <section className="sensitive-review" role="status" aria-live="polite">
      <header className="sensitive-review-head">
        <span className="sensitive-review-icon" aria-hidden="true">
          🛡
        </span>
        <div>
          <strong>{headline(report)}</strong>
          <p className="sensitive-review-sub">
            This ran on your computer and masked these values before the analysis was sent to
            GitHub Copilot. No action is needed — it&apos;s here so you know what was hidden.
          </p>
        </div>
        <button className="sensitive-dismiss linky" onClick={onDismiss} aria-label="Dismiss">
          Dismiss
        </button>
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
        Always-on detection covers secrets and personal details in text (window titles, URLs,
        clipboard, terminal commands, notes, and voice). Turn on Advanced protection to also
        detect names and blur sensitive text inside screen frames.
      </p>
    </section>
  );
}
