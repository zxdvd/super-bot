/** Run alias `latest`. The original settlement receipt also exists in older ledgers. */
export const settledBlockerSql = `CASE
  WHEN latest.finishedAt IS NOT NULL AND latest.state IN ('failed','interrupted','settled')
    AND NOT EXISTS (SELECT 1 FROM resources WHERE runId=latest.id)
    AND EXISTS (SELECT 1 FROM inputs WHERE id=latest.inputId AND state='entered')
  THEN CASE
    WHEN latest.state IN ('interrupted','settled') AND EXISTS (
      SELECT 1 FROM metadata WHERE key='run-verified-end:' || latest.id
    ) THEN 'verified-end'
    WHEN latest.state='failed' AND EXISTS (
      SELECT 1 FROM reports f JOIN events e ON e.taskId=latest.taskId AND e.kind='run.settled'
      WHERE f.runId=latest.id AND f.kind IN ('failed','blocked')
        AND json_extract(e.data,'$.runId')=latest.id AND json_extract(e.data,'$.kind')=f.kind
    ) THEN 'settled-failure'
  END
END`;
