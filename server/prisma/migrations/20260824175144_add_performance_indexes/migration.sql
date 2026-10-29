-- CreateIndex
CREATE INDEX "AuditEvent_migrationId_idx" ON "AuditEvent"("migrationId");

-- CreateIndex
CREATE INDEX "Migration_state_idx" ON "Migration"("state");

-- CreateIndex
CREATE INDEX "Migration_clientId_idx" ON "Migration"("clientId");

-- CreateIndex
CREATE INDEX "UptimeSample_migrationId_at_idx" ON "UptimeSample"("migrationId", "at");
