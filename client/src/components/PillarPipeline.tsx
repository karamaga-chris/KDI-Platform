/**
 * PillarPipeline — the visual centerpiece of the operator console.
 * Renders the SAME three-pillar discipline for both onboarding paths — the
 * exact states differ (a migration has a cutover; a greenfield app has a
 * launch instead), but the guard discipline and pillar structure are shared.
 */
type Props = {
  current: string;
  meta: Record<string, { pillar: number; label: string; description: string }>;
  happyPath: readonly string[];
  migrationType: 'MIGRATION' | 'GREENFIELD';
};

const PILLARS_BY_TYPE: Record<Props['migrationType'], { n: number; name: string; color: string; states: string[] }[]> = {
  MIGRATION: [
    { n: 1, name: 'Pillar 1 · Pre-Flight Audit', color: '#2563eb', states: ['created', 'discovery', 'auditReady'] },
    { n: 2, name: 'Pillar 2 · Background Sync', color: '#7c3aed', states: ['provisioning', 'replicating', 'staging'] },
    { n: 3, name: 'Pillar 3 · Zero-Downtime Cutover', color: '#059669', states: ['cutover', 'monitoring'] },
  ],
  GREENFIELD: [
    { n: 1, name: 'Pillar 1 · Requirements & Sizing', color: '#2563eb', states: ['created', 'intake', 'sizingReady'] },
    { n: 2, name: 'Pillar 2 · Environment Setup', color: '#7c3aed', states: ['provisioning', 'smokeTest'] },
    { n: 3, name: 'Pillar 3 · Go-Live', color: '#059669', states: ['launch', 'monitoring'] },
  ],
};

export function PillarPipeline({ current, meta, happyPath, migrationType }: Props) {
  const idx = happyPath.indexOf(current);
  const pillars = PILLARS_BY_TYPE[migrationType] ?? PILLARS_BY_TYPE.MIGRATION;
  return (
    <div className="pipeline">
      {pillars.map((pillar) => (
        <div key={pillar.n} className="pillar" style={{ borderTopColor: pillar.color }}>
          <div className="pillar-title" style={{ color: pillar.color }}>{pillar.name}</div>
          <div className="pillar-states">
            {pillar.states.map((s) => {
              const done = happyPath.indexOf(s) < idx && idx >= 0;
              const active = s === current;
              return (
                <div key={s} className={`stage ${active ? 'active' : ''} ${done ? 'done' : ''}`}
                     style={active ? { borderColor: pillar.color, background: pillar.color + '14' } : undefined}>
                  <div className="stage-dot" style={{ background: active || done ? pillar.color : '#cbd5e1' }} />
                  <div>
                    <div className="stage-label">{meta[s]?.label ?? s}</div>
                    <div className="stage-desc">{meta[s]?.description ?? ''}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      {(current === 'failed' || current === 'rolledBack') && (
        <div className="pillar" style={{ borderTopColor: '#dc2626' }}>
          <div className="pillar-title" style={{ color: '#dc2626' }}>Terminal</div>
          <div className="pillar-states">
            <div className="stage active" style={{ borderColor: '#dc2626', background: '#dc262614' }}>
              <div className="stage-dot" style={{ background: '#dc2626' }} />
              <div>
                <div className="stage-label">{meta[current]?.label ?? current}</div>
                <div className="stage-desc">{meta[current]?.description ?? ''}</div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
