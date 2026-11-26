// `latest` is the latest run for task `t`. `late` is metadata for that run.
export const currentLateJobSql = `
  json_extract(late.value,'$.state') IN ('waiting','ready')
  AND json_extract(late.value,'$.rowVersion')=t.rowVersion
  AND t.lifecycle='open' AND latest.state='interrupted' AND latest.taskRevision=t.taskRevision
  AND NOT EXISTS (SELECT 1 FROM metadata WHERE key='task-close:' || t.id)
  AND EXISTS (SELECT 1 FROM bindings b WHERE b.id=latest.bindingId AND b.taskId=t.id AND b.state='ready'
    AND b.generation=latest.generation AND b.sessionId=latest.sessionId AND b.taskRevision=t.taskRevision)
  AND EXISTS (SELECT 1 FROM run_turns WHERE runId=latest.id AND quiet=0 AND endSeq IS NOT NULL)
  AND EXISTS (SELECT 1 FROM inputs WHERE id=latest.inputId AND state='entered')
  AND EXISTS (SELECT 1 FROM resources WHERE runId=latest.id)
  AND EXISTS (SELECT 1 FROM attentions WHERE id='run:' || latest.id AND state='open')
  AND NOT EXISTS (SELECT 1 FROM attentions WHERE taskId=t.id AND id!='run:' || latest.id
    AND (state IN ('open','responding') OR kind='approval' AND state='stale'))
  AND NOT EXISTS (SELECT 1 FROM inputs WHERE taskId=t.id AND kind!='goal' AND state IN ('accepted','enqueued','unknown'))
  AND (coalesce(json_extract(late.value,'$.instructionId'),'')='' OR EXISTS (
    SELECT 1 FROM metadata i WHERE i.key='recovery-instruction:' || t.id
      AND json_extract(i.value,'$.id')=json_extract(late.value,'$.instructionId')
      AND json_extract(i.value,'$.priorRunId')=latest.id AND coalesce(json_extract(i.value,'$.runId'),'')=''
      AND NOT EXISTS (SELECT 1 FROM json_each(i.value,'$.directionRefs') ref
        WHERE NOT EXISTS (SELECT 1 FROM metadata WHERE key='recovery-direction-source:' || json_extract(ref.value,'$.id')))
  ))`;
