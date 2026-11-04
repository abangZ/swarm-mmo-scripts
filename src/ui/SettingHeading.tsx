import { useId, useState, type ReactNode } from 'react';

/** Help stays beside its field, outside the label so clicking it cannot toggle an input. */
export function SettingHeading({ htmlFor, label, help, children }: {
  htmlFor?: string; label: string; help: string; children?: ReactNode;
}) {
  const tipId = useId();
  const [open, setOpen] = useState(false);
  return <div className="setting-heading">
    {children ?? <label htmlFor={htmlFor}>{label}</label>}
    <span className="setting-help" onMouseEnter={() => setOpen(true)} onMouseLeave={() => setOpen(false)}>
      <button type="button" className="help-trigger" aria-label={`${label}说明`} aria-describedby={open ? tipId : undefined}
        onFocus={() => setOpen(true)} onBlur={() => setOpen(false)} onClick={() => setOpen(true)}
        onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); } }}>?</button>
      {open && <span id={tipId} role="tooltip" className="setting-tip">{help}</span>}
    </span>
  </div>;
}
