import type {AnalysisRecord, WritingInput} from '../../shared/contracts';

/** Restoring a saved run is an explicit UI action; incoming events never replace unsaved inputs. */
export function savedWritingSession(record: AnalysisRecord): {
  form: WritingInput; step: WritingInput['stage']; basisId: string; engine: AnalysisRecord['engine'];
} | undefined {
  if (!record.writing) return undefined;
  return {
    form:structuredClone(record.writing),step:record.writing.stage,engine:record.engine,
    basisId:record.writing.stage === 'paragraph' ? record.basisAnalysisId ?? '' :
      record.writing.stage === 'outline' && record.status === 'succeeded' ? record.id : '',
  };
}
