import { Type } from 'typebox';
import { ResourceId, Revision } from './common.ts';
export const StoryboardDraftRequest=Type.Object({
  projectId:ResourceId,
  scriptVersion:Type.Integer({minimum:1}),
  expectedBoardRevision:Revision,
},{additionalProperties:false});
