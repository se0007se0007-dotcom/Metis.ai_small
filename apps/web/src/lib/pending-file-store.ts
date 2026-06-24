/**
 * Global store for pending files from drag-drop uploads.
 *
 * Separated from builder/page.tsx to prevent Next.js Fast Refresh
 * full reloads. When a 'use client' page exports non-component functions,
 * Next.js cannot do partial HMR and does a full reload instead.
 *
 * By keeping this in a plain module, changes to builder/page.tsx
 * no longer trigger full reloads, preserving builder state during development.
 */

const pendingFileStore: Map<string, File[]> = new Map();

export function storePendingFiles(nodeId: string, files: File[]) {
  const existing = pendingFileStore.get(nodeId) || [];
  pendingFileStore.set(nodeId, [...existing, ...files]);
}

export function getPendingFiles(nodeId: string): File[] {
  return pendingFileStore.get(nodeId) || [];
}

export function clearPendingFiles(nodeId: string) {
  pendingFileStore.delete(nodeId);
}
