// A copy of Band's catalog entry schema (band-app/band, apps/hub/src/server/services/
// extension-catalog-service.ts at v0.61.0). The hub skips an entry that fails it, so the
// generator refuses to write one. Keep this file in step with Band when its schema changes.
import { z } from "zod";

/** True for exactly MAJOR.MINOR.PATCH with no prefix, suffix or leading zeros (Band's isStrictSemver). */
export const STRICT_SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
export const isStrictSemver = (v) => typeof v === "string" && v.length <= 32 && STRICT_SEMVER.test(v);

const semver = z.string().refine((v) => isStrictSemver(v), "not a plain MAJOR.MINOR.PATCH version");

export const catalogEntrySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{0,63}$/),
  name: z.string().min(1).max(100),
  description: z.string().max(1000).default(""),
  version: semver,
  url: z.string().min(1).max(2000),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i),
  minBand: semver,
  worker: z.boolean().default(false),
  requires: z.array(z.string().max(100)).max(20).default([]),
});

/** The `catalog.json` each extension ships beside its manifest: what the manifest has no field for. */
export const catalogMetaSchema = z
  .object({
    description: z.string().min(1).max(1000),
    minBand: semver,
  })
  .strict();
