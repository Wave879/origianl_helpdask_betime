-- Preserve original duplicates and a durable ID mapping before consolidating.
CREATE TABLE IF NOT EXISTS hd_user_merge_archive (
  old_id TEXT PRIMARY KEY,
  canonical_id TEXT NOT NULL,
  original_row JSONB NOT NULL,
  merged_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO hd_user_merge_archive (old_id, canonical_id, original_row)
SELECT id, canonical_id, original_row FROM (
  SELECT h.id, to_jsonb(h) original_row,
    first_value(h.id) OVER (
      PARTITION BY lower(trim(h.extra::jsonb->>'email')) ORDER BY h.created_at ASC NULLS LAST, h.id
    ) canonical_id
  FROM hd_master h WHERE table_name='hd_users'
    AND NULLIF(trim(h.extra::jsonb->>'email'),'') IS NOT NULL
    AND h.extra::jsonb->>'merged_into' IS NULL
) ranked WHERE id<>canonical_id ON CONFLICT (old_id) DO NOTHING;

-- Rewrite exact identity references in structured metadata, including arrays.
CREATE FUNCTION pg_temp.remap_role_user_ids(value JSONB) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE mapped TEXT;
BEGIN
  CASE jsonb_typeof(value)
    WHEN 'string' THEN
      SELECT canonical_id INTO mapped FROM hd_user_merge_archive WHERE old_id=value #>> '{}';
      RETURN CASE WHEN mapped IS NULL THEN value ELSE to_jsonb(mapped) END;
    WHEN 'array' THEN
      RETURN COALESCE((SELECT jsonb_agg(pg_temp.remap_role_user_ids(v) ORDER BY n)
        FROM jsonb_array_elements(value) WITH ORDINALITY a(v,n)), '[]'::jsonb);
    WHEN 'object' THEN
      RETURN COALESCE((SELECT jsonb_object_agg(k, pg_temp.remap_role_user_ids(v))
        FROM jsonb_each(value) a(k,v)), '{}'::jsonb);
    ELSE RETURN value;
  END CASE;
END $$;

UPDATE hd_master h SET extra=pg_temp.remap_role_user_ids(h.extra::jsonb)::text
WHERE table_name<>'hd_users' AND EXISTS (
  SELECT 1 FROM hd_user_merge_archive a WHERE strpos(h.extra,a.old_id)>0
);

UPDATE hd_master h SET extra=(h.extra::jsonb || jsonb_build_object(
  'merged_user_ids', (SELECT jsonb_agg(a.old_id ORDER BY a.old_id) FROM hd_user_merge_archive a WHERE a.canonical_id=h.id)
))::text WHERE EXISTS (SELECT 1 FROM hd_user_merge_archive a WHERE a.canonical_id=h.id);

-- Retain archived rows for references outside Helpdesk; omit them from active catalogues.
UPDATE hd_master h SET extra=(h.extra::jsonb || jsonb_build_object('merged_into',a.canonical_id))::text
FROM hd_user_merge_archive a WHERE h.id=a.old_id;

CREATE UNIQUE INDEX IF NOT EXISTS hd_users_unique_email
ON hd_master (lower(trim(extra::jsonb->>'email')))
WHERE table_name='hd_users' AND extra::jsonb->>'merged_into' IS NULL
  AND NULLIF(trim(extra::jsonb->>'email'),'') IS NOT NULL;
