/**
 * Tests that prove the machine's SAFETY guarantees hold. These are the
 * evidence that the three-pillar workflow is genuinely enforced, not cosmetic.
 */
import { describe, it, expect } from 'vitest';
import { createActor } from 'xstate';
import { migrationMachine, withinGuaranteeWindow } from './migrationMachine.js';

function fresh() {
  const actor = createActor(migrationMachine, {
    input: { migrationId: 'm1', clientId: 'c1', migrationType: 'MIGRATION', guaranteeWindowDays: 30 },
  });
  actor.start();
  return actor;
}

function freshGreenfield() {
  const actor = createActor(migrationMachine, {
    input: { migrationId: 'g1', clientId: 'c2', migrationType: 'GREENFIELD', guaranteeWindowDays: 30 },
  });
  actor.start();
  return actor;
}

describe('three-pillar migration machine', () => {
  it('walks the happy path to monitoring', () => {
    const a = fresh();
    a.send({ type: 'START_AUDIT' });
    a.send({ type: 'AUDIT_COMPLETE', dataVolumeGB: 60, estimatedDowntimeMin: 4, latencyBeforeMs: 250 });
    a.send({ type: 'APPROVE_AUDIT', providerId: 'aos' });
    a.send({ type: 'PROVISION_DONE' });
    a.send({ type: 'REPLICATION_HEALTHY', replicationLagSec: 2 });
    a.send({ type: 'INTEGRITY_PASS' });
    a.send({ type: 'CLIENT_SIGN_OFF' });
    a.send({ type: 'EXECUTE_CUTOVER', latencyAfterMs: 40 });
    expect(String(a.getSnapshot().value)).toBe('monitoring');
    expect(a.getSnapshot().context.latencyAfterMs).toBe(40);
  });

  it('REFUSES cutover without client sign-off (defensibility guard)', () => {
    const a = fresh();
    a.send({ type: 'START_AUDIT' });
    a.send({ type: 'AUDIT_COMPLETE', dataVolumeGB: 60, estimatedDowntimeMin: 4, latencyBeforeMs: 250 });
    a.send({ type: 'APPROVE_AUDIT', providerId: 'aos' });
    a.send({ type: 'PROVISION_DONE' });
    a.send({ type: 'REPLICATION_HEALTHY', replicationLagSec: 2 });
    a.send({ type: 'INTEGRITY_PASS' });
    // NOTE: no CLIENT_SIGN_OFF
    a.send({ type: 'EXECUTE_CUTOVER', latencyAfterMs: 40 });
    // Guard blocks it: still in staging.
    expect(String(a.getSnapshot().value)).toBe('staging');
  });

  it('REFUSES cutover without integrity pass', () => {
    const a = fresh();
    a.send({ type: 'START_AUDIT' });
    a.send({ type: 'AUDIT_COMPLETE', dataVolumeGB: 60, estimatedDowntimeMin: 4, latencyBeforeMs: 250 });
    a.send({ type: 'APPROVE_AUDIT', providerId: 'aos' });
    a.send({ type: 'PROVISION_DONE' });
    a.send({ type: 'REPLICATION_HEALTHY', replicationLagSec: 2 });
    a.send({ type: 'CLIENT_SIGN_OFF' });
    // NOTE: no INTEGRITY_PASS
    a.send({ type: 'EXECUTE_CUTOVER', latencyAfterMs: 40 });
    expect(String(a.getSnapshot().value)).toBe('staging');
  });

  it('enforces the 30-day Safe Rollback guarantee window', () => {
    const cutIso = new Date('2026-01-01T00:00:00Z').toISOString();
    const inWindow = withinGuaranteeWindow(
      { cutoverAt: cutIso, guaranteeWindowDays: 30 } as any,
      '2026-01-20T00:00:00Z',
    );
    const outWindow = withinGuaranteeWindow(
      { cutoverAt: cutIso, guaranteeWindowDays: 30 } as any,
      '2026-03-01T00:00:00Z',
    );
    expect(inWindow).toBe(true);
    expect(outWindow).toBe(false);
  });
});

describe('greenfield (new app, no migration) machine', () => {
  it('walks the requirements -> setup -> go-live happy path to monitoring', () => {
    const a = freshGreenfield();
    a.send({ type: 'START_INTAKE' });
    a.send({ type: 'INTAKE_COMPLETE', dataVolumeGB: 15 });
    a.send({ type: 'APPROVE_SIZING', providerId: 'aos' });
    a.send({ type: 'PROVISION_DONE', targetEndpoint: 'http://localhost:5050/ping' });
    a.send({ type: 'SMOKE_TEST_PASS' });
    a.send({ type: 'GO_LIVE', latencyAfterMs: 12 });
    expect(String(a.getSnapshot().value)).toBe('monitoring');
    expect(a.getSnapshot().context.targetEndpoint).toBe('http://localhost:5050/ping');
  });

  it('REFUSES go-live without a passed smoke test (defensibility guard)', () => {
    const a = freshGreenfield();
    a.send({ type: 'START_INTAKE' });
    a.send({ type: 'INTAKE_COMPLETE', dataVolumeGB: 15 });
    a.send({ type: 'APPROVE_SIZING', providerId: 'aos' });
    a.send({ type: 'PROVISION_DONE' });
    // NOTE: no SMOKE_TEST_PASS
    a.send({ type: 'GO_LIVE', latencyAfterMs: 12 });
    expect(String(a.getSnapshot().value)).toBe('smokeTest');
  });

  it('provisioning branches by type: greenfield never enters replicating/staging', () => {
    const a = freshGreenfield();
    a.send({ type: 'START_INTAKE' });
    a.send({ type: 'INTAKE_COMPLETE', dataVolumeGB: 15 });
    a.send({ type: 'APPROVE_SIZING', providerId: 'aos' });
    a.send({ type: 'PROVISION_DONE' });
    expect(String(a.getSnapshot().value)).toBe('smokeTest'); // not 'replicating'
  });

  it('a MIGRATION-typed machine cannot start the greenfield intake path', () => {
    const a = fresh(); // migrationType MIGRATION
    a.send({ type: 'START_INTAKE' });
    expect(String(a.getSnapshot().value)).toBe('created'); // guard blocked it
  });

  it('a GREENFIELD-typed machine cannot start the migration audit path', () => {
    const a = freshGreenfield();
    a.send({ type: 'START_AUDIT' });
    expect(String(a.getSnapshot().value)).toBe('created'); // guard blocked it
  });

  it('enforces the guarantee window using goLiveAt (not cutoverAt)', () => {
    const liveIso = new Date('2026-01-01T00:00:00Z').toISOString();
    const inWindow = withinGuaranteeWindow(
      { cutoverAt: null, goLiveAt: liveIso, guaranteeWindowDays: 30 } as any,
      '2026-01-15T00:00:00Z',
    );
    const outWindow = withinGuaranteeWindow(
      { cutoverAt: null, goLiveAt: liveIso, guaranteeWindowDays: 30 } as any,
      '2026-04-01T00:00:00Z',
    );
    expect(inWindow).toBe(true);
    expect(outWindow).toBe(false);
  });
});
