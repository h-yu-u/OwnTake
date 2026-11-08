export interface ShotCastBinding {
  shotId: string;
  roleId: string;
  projectId: string;
  characterId: string;
  characterName: string;
  roleName: string;
  visualVersion: number;
  lookId: string | null;
  referenceArtifactId: string;
  createdAt: string;
}
export interface CastReferenceSnapshot {
  roleId: string;
  characterId: string;
  visualVersion: number;
  lookId: string | null;
  referenceArtifactId: string;
}
