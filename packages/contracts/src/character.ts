export interface CharacterInput {
  name: string;
  biography: string;
  appearance: string;
  style: string;
  voicePreset: string;
}
export interface Character extends CharacterInput {
  id: string;
  revision: number;
  lockedVisualVersion: number | null;
  createdAt: string;
  updatedAt: string;
}
export interface CharacterVisual {
  id: string;
  characterId: string;
  version: number;
  mime: 'image/png' | 'image/jpeg' | 'image/webp';
  sha256: string;
  sizeBytes: number;
  width: number;
  height: number;
  createdAt: string;
}
export interface CharacterLook {
  id: string;
  characterId: string;
  name: string;
  outfit: string;
  mood: string;
  visualVersion: number;
  createdAt: string;
}
export interface ProjectRole {
  id: string;
  projectId: string;
  characterId: string;
  visualVersion: number;
  lookId: string | null;
  roleName: string;
  artifactId: string;
  createdAt: string;
}
