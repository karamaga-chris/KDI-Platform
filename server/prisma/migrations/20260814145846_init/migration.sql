-- CreateEnum
CREATE TYPE "ServiceTier" AS ENUM ('STARTUP', 'GROWTH', 'PREMIUM');

-- CreateEnum
CREATE TYPE "MigrationType" AS ENUM ('MIGRATION', 'GREENFIELD');

-- CreateTable
CREATE TABLE "Client" (
    "id" TEXT NOT NULL,
    "orgName" TEXT NOT NULL,
    "sector" TEXT NOT NULL,
    "currentProvider" TEXT NOT NULL,
    "endpoint" TEXT,
    "dataVolumeGB" INTEGER NOT NULL,
    "tier" "ServiceTier" NOT NULL DEFAULT 'STARTUP',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Migration" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "migrationType" "MigrationType" NOT NULL DEFAULT 'MIGRATION',
    "state" TEXT NOT NULL DEFAULT 'created',
    "providerId" TEXT,
    "dataVolumeGB" INTEGER,
    "estimatedDowntimeMin" INTEGER,
    "replicationLagSec" INTEGER,
    "integrityPassed" BOOLEAN NOT NULL DEFAULT false,
    "clientSignedOff" BOOLEAN NOT NULL DEFAULT false,
    "smokeTestPassed" BOOLEAN NOT NULL DEFAULT false,
    "cutoverAt" TIMESTAMP(3),
    "goLiveAt" TIMESTAMP(3),
    "guaranteeWindowDays" INTEGER NOT NULL DEFAULT 30,
    "latencyBeforeMs" INTEGER,
    "latencyAfterMs" INTEGER,
    "targetEndpoint" TEXT,
    "auditReportJson" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Migration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "migrationId" TEXT NOT NULL,
    "fromState" TEXT NOT NULL,
    "toState" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "pillar" INTEGER NOT NULL,
    "detail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UptimeSample" (
    "id" TEXT NOT NULL,
    "migrationId" TEXT NOT NULL,
    "up" BOOLEAN NOT NULL,
    "latencyMs" INTEGER NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'simulated',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UptimeSample_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Invoice" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "wholesaleUsd" DOUBLE PRECISION NOT NULL,
    "retailUsd" DOUBLE PRECISION NOT NULL,
    "marginUsd" DOUBLE PRECISION NOT NULL,
    "rwfAmount" DOUBLE PRECISION NOT NULL,
    "fxRate" DOUBLE PRECISION NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Invoice_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "Migration" ADD CONSTRAINT "Migration_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_migrationId_fkey" FOREIGN KEY ("migrationId") REFERENCES "Migration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UptimeSample" ADD CONSTRAINT "UptimeSample_migrationId_fkey" FOREIGN KEY ("migrationId") REFERENCES "Migration"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Invoice" ADD CONSTRAINT "Invoice_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
