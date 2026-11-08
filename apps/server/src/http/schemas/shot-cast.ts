import { Type } from 'typebox';
import { ExistingRevision, ResourceId } from './common.ts';
export const ShotCastInput=Type.Object({
  roleIds:Type.Array(ResourceId,{uniqueItems:true,maxItems:4}),
  expectedShotRevision:ExistingRevision,
},{additionalProperties:false});
