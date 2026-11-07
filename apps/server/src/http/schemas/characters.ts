import { Type } from 'typebox';
import { ExistingRevision, ResourceId } from './common.ts';
export const CharacterInput=Type.Object({
  name:Type.String({minLength:1,maxLength:120}),
  biography:Type.String({maxLength:4000}),
  appearance:Type.String({maxLength:2000}),
  style:Type.String({maxLength:600}),
  voicePreset:Type.String({maxLength:200}),
},{additionalProperties:false});
export const CharacterUpdate=Type.Object({...CharacterInput.properties,expectedRevision:ExistingRevision},{additionalProperties:false});
export const CharacterSearch=Type.Object({q:Type.Optional(Type.String({maxLength:100}))},{additionalProperties:false});
export const CharacterParams=Type.Object({id:ResourceId},{additionalProperties:false});
export const VisualParams=Type.Object({id:ResourceId,version:Type.Integer({minimum:1})},{additionalProperties:false});
export const LookInput=Type.Object({
  name:Type.String({minLength:1,maxLength:120}),
  outfit:Type.String({maxLength:1200}),mood:Type.String({maxLength:600}),
  visualVersion:Type.Integer({minimum:1}),
},{additionalProperties:false});
export const ProjectRoleInput=Type.Object({
  characterId:ResourceId,visualVersion:Type.Integer({minimum:1}),
  lookId:Type.Union([ResourceId,Type.Null()]),
  roleName:Type.String({minLength:1,maxLength:120}),
},{additionalProperties:false});

export const VisualFromArtifact=Type.Object({artifactId:ResourceId},{additionalProperties:false});
